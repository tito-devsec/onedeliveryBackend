import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute } from "../config/db.js";
import { sendPushNotification } from "../services/notification.service.js";
import { uploadBuffer } from "../services/upload.service.js";

// GET /api/chat/conversations
export async function myConversations(req, res) {
  try {
    const convs = await query(
      `SELECT c.id, c.type, c.order_id, c.ride_id, c.updated_at,
              cp.unread_count,
              m.body AS last_message, m.created_at AS last_message_at,
              GROUP_CONCAT(DISTINCT u.name ORDER BY u.name SEPARATOR ', ') AS participants
       FROM conversations c
       JOIN conversation_participants cp ON c.id = cp.conversation_id AND cp.user_id = ?
       JOIN conversation_participants cp2 ON c.id = cp2.conversation_id
       JOIN users u ON cp2.user_id = u.id AND u.id != ?
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
       )
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT 50`,
      [req.user.id, req.user.id]
    );
    res.json({ conversations: convs });
  } catch (err) {
    console.error("myConversations:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/chat/conversations/:id/messages
export async function getMessages(req, res) {
  try {
    const { id } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    // Verify participant
    const part = await queryOne(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [id, req.user.id]
    );
    if (!part) return res.status(403).json({ error: "Not a participant" });

    const messages = await query(
      `SELECT m.*, u.name AS sender_name, u.profile_image AS sender_image, u.role AS sender_role
       FROM messages m JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC
       LIMIT ? OFFSET ?`,
      [id, parseInt(limit), offset]
    );

    // Mark read
    await execute(
      "UPDATE conversation_participants SET unread_count = 0, last_read_at = NOW() WHERE conversation_id = ? AND user_id = ?",
      [id, req.user.id]
    );
    await execute("UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?", [id, req.user.id]);

    res.json({ messages: messages.reverse() });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/chat/conversations  (start or get existing)
export async function startConversation(req, res) {
  try {
    let { recipientId, type, orderId, rideId } = req.body;
    if (!recipientId) return res.status(400).json({ error: "recipientId required" });

    // The mobile app opens support chat with the literal id "admin" — resolve it
    // to the first active admin account.
    let recipient;
    if (recipientId === "admin" || recipientId === "support") {
      recipient = await queryOne(
        "SELECT id, name, role FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at ASC LIMIT 1"
      );
      if (!recipient) return res.status(404).json({ error: "No support agent available yet" });
      recipientId = recipient.id;
    } else {
      recipient = await queryOne("SELECT id, name, role FROM users WHERE id = ?", [recipientId]);
    }
    if (!recipient) return res.status(404).json({ error: "Recipient not found" });

    // ── Chat policy ──────────────────────────────────────────────────────────
    // Customers and sellers may only chat with OneDelivery support (admin).
    // Direct customer↔seller contact is not allowed. Chat with a driver is only
    // allowed in the context of an active ride/delivery.
    if (["customer", "seller"].includes(req.user.role)) {
      const driverWithRide = recipient.role === "driver" && (rideId || orderId);
      if (recipient.role !== "admin" && !driverWithRide) {
        return res.status(403).json({ error: "You can only chat with OneDelivery support" });
      }
    }

    // Check for existing conversation between same two users (and same order if provided)
    let existingId = null;
    if (orderId) {
      const ex = await queryOne(
        `SELECT c.id FROM conversations c
         JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = ?
         JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = ?
         WHERE c.order_id = ? LIMIT 1`,
        [req.user.id, recipientId, orderId]
      );
      existingId = ex?.id;
    } else {
      const ex = await queryOne(
        `SELECT c.id FROM conversations c
         JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = ?
         JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = ?
         WHERE c.order_id IS NULL AND c.ride_id IS NULL LIMIT 1`,
        [req.user.id, recipientId]
      );
      existingId = ex?.id;
    }

    if (existingId) return res.json({ conversationId: existingId, existing: true });

    // Determine conversation type
    const myRole   = req.user.role;
    const theirRole = recipient.role;
    let convType = "user_seller";
    if ((myRole === "customer" || myRole === "seller") && theirRole === "admin") convType = "user_admin";
    else if (myRole === "seller"  && theirRole === "admin")   convType = "seller_admin";
    else if ((myRole === "customer" || myRole === "seller") && theirRole === "driver") {
      convType = myRole === "seller" ? "seller_driver" : "user_driver";
    }
    if (type) convType = type;

    const convId = uuidv4();
    await execute(
      "INSERT INTO conversations (id, type, order_id, ride_id) VALUES (?, ?, ?, ?)",
      [convId, convType, orderId || null, rideId || null]
    );
    await execute("INSERT INTO conversation_participants (conversation_id, user_id) VALUES (?, ?), (?, ?)",
      [convId, req.user.id, convId, recipientId]);

    res.status(201).json({ conversationId: convId, existing: false });
  } catch (err) {
    console.error("startConversation:", err.message);
    res.status(500).json({ error: "Failed to create conversation" });
  }
}

// POST /api/chat/conversations/:id/messages
export async function sendMessage(req, res) {
  try {
    const { id } = req.params;
    const { body, type = "text" } = req.body;

    const part = await queryOne(
      "SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND user_id = ?",
      [id, req.user.id]
    );
    if (!part) return res.status(403).json({ error: "Not a participant" });

    let imageUrl = null;
    if (req.file) {
      const result = await uploadBuffer(req.file.buffer, "chat");
      imageUrl = result.secure_url;
    }

    if (!body && !imageUrl) return res.status(400).json({ error: "Message body or image required" });

    const msgId = uuidv4();
    await execute(
      "INSERT INTO messages (id, conversation_id, sender_id, body, type, image_url) VALUES (?, ?, ?, ?, ?, ?)",
      [msgId, id, req.user.id, body || "", imageUrl ? "image" : type, imageUrl]
    );

    // Update conversation timestamp and unread counts
    await execute("UPDATE conversations SET updated_at = NOW() WHERE id = ?", [id]);
    await execute(
      "UPDATE conversation_participants SET unread_count = unread_count + 1 WHERE conversation_id = ? AND user_id != ?",
      [id, req.user.id]
    );

    const msg = await queryOne(
      `SELECT m.*, u.name AS sender_name, u.profile_image AS sender_image
       FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?`,
      [msgId]
    );

    // Emit via Socket.io
    const io = req.app.get("io");
    if (io) io.to(`conv:${id}`).emit("new_message", msg);

    // Push notification to other participants
    const others = await query(
      "SELECT user_id FROM conversation_participants WHERE conversation_id = ? AND user_id != ?",
      [id, req.user.id]
    );
    for (const p of others) {
      sendPushNotification(p.user_id, {
        title: `💬 ${req.user.name}`,
        body:  imageUrl ? "Sent an image" : (body?.slice(0, 80) || ""),
        type:  "new_message",
        data:  { conversationId: id, screen: "chat" },
      }).catch(() => {});
    }

    res.status(201).json({ message: msg });
  } catch (err) {
    console.error("sendMessage:", err.message);
    res.status(500).json({ error: "Send failed" });
  }
}

// GET /api/chat/contacts  (ADMIN ONLY — list customers & sellers to start a chat)
export async function chatContacts(req, res) {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const { role, search } = req.query;
    let where = "u.role IN ('customer','seller') AND u.is_active = 1";
    const vals = [];
    if (role && ["customer", "seller"].includes(role)) { where += " AND u.role = ?"; vals.push(role); }
    if (search) { where += " AND (u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)"; vals.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const contacts = await query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.profile_image, sp.shop_name
       FROM users u
       LEFT JOIN seller_profiles sp ON sp.user_id = u.id
       WHERE ${where}
       ORDER BY u.role ASC, u.name ASC
       LIMIT 300`,
      vals
    );
    res.json({ contacts });
  } catch (err) {
    console.error("chatContacts:", err.message);
    res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/chat/unread
export async function unreadCount(req, res) {
  try {
    const [row] = await query(
      "SELECT SUM(unread_count) AS total FROM conversation_participants WHERE user_id = ?",
      [req.user.id]
    );
    res.json({ unread: parseInt(row.total) || 0 });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}
