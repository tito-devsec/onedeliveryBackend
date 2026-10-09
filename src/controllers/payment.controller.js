import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne, execute, withTransaction } from "../config/db.js";
import { ENV } from "../config/env.js";
import { sendPushNotification } from "../services/notification.service.js";
import {
  initiateMobilePayment, initiateCardPayment,
  initiateDeliveryPayment, initiatePackagePayment,
  initiatePayout, verifyWebhookSignature,
  MOBILE_PROVIDERS, detectProvider,
} from "../services/snippe.service.js";

function genRef() { return "ORD-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(); }
function idemKey(prefix, id) { return (prefix + id.replace(/-/g, "")).slice(0, 30); }

// GET /api/payment/providers
export function getProviders(req, res) {
  res.json({ providers: MOBILE_PROVIDERS });
}

// POST /api/payment/checkout  (mobile money)
export async function checkout(req, res) {
  try {
    const { cartItems, shippingAddress, payerPhone } = req.body;
    const user = req.user;
    if (!cartItems?.length) return res.status(400).json({ error: "Cart is empty" });
    if (!payerPhone) return res.status(400).json({ error: "Phone number required" });

    let subtotal = 0;
    const validated = [];

    await withTransaction(async (conn) => {
      for (const item of cartItems) {
        const pid = item.product_id || item.product?.id;
        const [rows] = await conn.execute(
          "SELECT * FROM products WHERE id = ? AND status = 'approved' FOR UPDATE", [pid]
        );
        const product = rows[0];
        if (!product) throw { status: 404, message: `Product not found: ${pid}` };
        if (product.stock < item.quantity) throw { status: 400, message: `Insufficient stock for ${product.name}` };
        subtotal += parseFloat(product.price) * item.quantity;
        const images = Array.isArray(product.images) ? product.images : JSON.parse(product.images || "[]");
        validated.push({ productId: product.id, sellerId: product.seller_id, name: product.name, price: parseFloat(product.price), quantity: item.quantity, image: images[0] || "" });
      }

      // Check active subscription for free shipping
      const [subs] = await conn.execute(
        "SELECT package_id FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > NOW() LIMIT 1",
        [user.id]
      );
      const sub = subs[0];
      const freeShip = sub && ["customer_vip","customer_premium"].includes(sub.package_id);
      // Product prices already include VAT.
      // Delivery is charged separately after the product order.
      const shippingCost = 0;
      const tax = Math.round((subtotal * ENV.TAX_RATE) / (1 + ENV.TAX_RATE));
      const total = subtotal;
      const internalRef = genRef();
      const orderId = uuidv4();

      // Determine seller (take first item's seller for now)
      const sellerId = validated[0]?.sellerId || null;

      await conn.execute(
        `INSERT INTO orders (id, user_id, seller_id, status, subtotal, shipping_cost, tax, total_price,
           shipping_address, payment_method, payment_provider, payment_ref, payment_status, payer_phone)
         VALUES (?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, 'mobile', 'snippe', ?, 'pending', ?)`,
        [orderId, user.id, sellerId, subtotal, shippingCost, tax, total, JSON.stringify(shippingAddress), internalRef, payerPhone]
      );

      for (const item of validated) {
        await conn.execute(
          "INSERT INTO order_items (id, order_id, product_id, name, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [uuidv4(), orderId, item.productId, item.name, item.price, item.quantity, item.image]
        );
        await conn.execute("UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?", [item.quantity, item.productId]);
      }

      // Initiate Snippe payment
      const payResult = await initiateMobilePayment({
        amount: total, phoneNumber: payerPhone,
        customer: { firstname: user.name.split(" ")[0] || "Customer", lastname: user.name.split(" ").slice(1).join(" ") || "User", email: user.email },
        orderId, idempotencyKey: idemKey("ORD", orderId),
      });

      if (!payResult.success) {
        // Rollback stock
        for (const item of validated) {
          await conn.execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.productId]);
        }
        await conn.execute("UPDATE orders SET status = 'cancelled', payment_status = 'failed' WHERE id = ?", [orderId]);
        throw { status: 400, message: payResult.message };
      }

      await conn.execute("UPDATE orders SET payment_ref = ?, payment_status = 'processing' WHERE id = ?", [payResult.reference, orderId]);
      await conn.execute("DELETE FROM cart_items WHERE user_id = ?", [user.id]);

      res.status(200).json({
        message: payResult.message,
        orderId, paymentRef: payResult.reference, total, currency: "TZS", status: "processing",
        expiresAt: payResult.expiresAt,
      });
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("checkout:", err.message);
    res.status(500).json({ error: "Checkout failed" });
  }
}

// POST /api/payment/checkout/card
export async function checkoutCard(req, res) {
  try {
    const { cartItems, shippingAddress, customerDetails } = req.body;
    const user = req.user;
    if (!cartItems?.length) return res.status(400).json({ error: "Cart is empty" });

    let subtotal = 0;
    const validated = [];

    for (const item of cartItems) {
      const pid = item.product_id || item.product?.id;
      const product = await queryOne("SELECT * FROM products WHERE id = ? AND status = 'approved'", [pid]);
      if (!product) return res.status(404).json({ error: "Product not found" });
      subtotal += parseFloat(product.price) * item.quantity;
      const images = Array.isArray(product.images) ? product.images : JSON.parse(product.images || "[]");
      validated.push({ productId: product.id, sellerId: product.seller_id, name: product.name, price: parseFloat(product.price), quantity: item.quantity, image: images[0] || "" });
    }

    // Product prices already include VAT.
    // Delivery is charged separately after the product order.
    const shippingCost = 0;
    const tax = Math.round((subtotal * ENV.TAX_RATE) / (1 + ENV.TAX_RATE));
    const total = subtotal;
    const orderId = uuidv4();
    const sellerId = validated[0]?.sellerId || null;

    await execute(
      `INSERT INTO orders (id, user_id, seller_id, status, subtotal, shipping_cost, tax, total_price,
         shipping_address, payment_method, payment_provider, payment_ref, payment_status)
       VALUES (?, ?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, 'card', 'snippe', ?, 'pending')`,
      [orderId, user.id, sellerId, subtotal, shippingCost, tax, total, JSON.stringify(shippingAddress), genRef()]
    );

    for (const item of validated) {
      await execute("INSERT INTO order_items (id, order_id, product_id, name, price, quantity, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv4(), orderId, item.productId, item.name, item.price, item.quantity, item.image]);
      await execute("UPDATE products SET stock = GREATEST(stock - ?, 0) WHERE id = ?", [item.quantity, item.productId]);
    }

    const payResult = await initiateCardPayment({
      amount: total,
      customer: { ...customerDetails, email: customerDetails.email || user.email },
      orderId,
      redirectUrl: `${ENV.CLIENT_URL}/payment/success?order=${orderId}`,
      cancelUrl:   `${ENV.CLIENT_URL}/payment/cancel?order=${orderId}`,
      idempotencyKey: idemKey("CRD", orderId),
    });

    if (!payResult.success) {
      for (const item of validated) await execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.productId]);
      await execute("UPDATE orders SET status = 'cancelled', payment_status = 'failed' WHERE id = ?", [orderId]);
      return res.status(400).json({ error: payResult.message });
    }

    await execute("UPDATE orders SET payment_ref = ?, payment_status = 'processing' WHERE id = ?", [payResult.reference, orderId]);
    await execute("DELETE FROM cart_items WHERE user_id = ?", [user.id]);

    res.json({ orderId, paymentUrl: payResult.paymentUrl, paymentToken: payResult.paymentToken, total, currency: "TZS" });
  } catch (err) {
    console.error("checkoutCard:", err.message);
    res.status(500).json({ error: "Card checkout failed" });
  }
}

// POST /api/payment/delivery  (pay for delivery fee after order)
export async function payDeliveryFee(req, res) {
  try {
    const { rideId, payerPhone } = req.body;
    if (!rideId || !payerPhone) return res.status(400).json({ error: "rideId and payerPhone required" });

    const ride = await queryOne(
      "SELECT * FROM ride_requests WHERE id = ? AND customer_id = ?",
      [rideId, req.user.id]
    );
    if (!ride) return res.status(404).json({ error: "Ride not found" });
    if (ride.delivery_fee_paid) return res.status(400).json({ error: "Delivery fee already paid" });
    // The price is negotiated: payment opens once a driver and price are agreed
    if (!["accepted", "going_to_shop", "picked_up", "on_the_way"].includes(ride.status)) {
      return res.status(400).json({ error: "You can pay once a driver has accepted your delivery", code: "not_agreed_yet" });
    }
    // Choosing to pay in the app (even after picking cash) switches the delivery to mobile money
    if (ride.payment_method !== "mobile") await execute("UPDATE ride_requests SET payment_method = 'mobile' WHERE id = ?", [rideId]);

    const user = req.user;
    const payResult = await initiateDeliveryPayment({
      amount: ride.fare, phoneNumber: payerPhone,
      customer: { firstname: user.name.split(" ")[0], lastname: user.name.split(" ").slice(1).join(" "), email: user.email },
      rideId,
      idempotencyKey: idemKey("DLV", rideId),
    });

    if (!payResult.success) return res.status(400).json({ error: payResult.message });

    await execute("UPDATE ride_requests SET delivery_payment_ref = ? WHERE id = ?", [payResult.reference, rideId]);
    res.json({ message: "Delivery payment initiated. Check your phone.", paymentRef: payResult.reference });
  } catch (err) {
    res.status(500).json({ error: "Delivery payment failed" });
  }
}

// GET /api/payment/status/:orderId
export async function paymentStatus(req, res) {
  try {
    const order = await queryOne(
      "SELECT id, status, payment_status, total_price FROM orders WHERE id = ? AND user_id = ?",
      [req.params.orderId, req.user.id]
    );
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ orderId: order.id, orderStatus: order.status, paymentStatus: order.payment_status, totalPrice: parseFloat(order.total_price), currency: "TZS" });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/payment/package  (buy a subscription)
export async function purchasePackage(req, res) {
  try {
    const { packageId, payerPhone } = req.body;
    if (!packageId || !payerPhone) return res.status(400).json({ error: "packageId and payerPhone required" });

    const pkg = await queryOne("SELECT * FROM packages WHERE id = ? AND is_active = 1", [packageId]);
    if (!pkg) return res.status(404).json({ error: "Package not found" });
    if (pkg.is_free) return res.status(400).json({ error: "Free package needs no payment" });

    const expires = new Date(Date.now() + pkg.duration_days * 86400 * 1000);
    const subId = uuidv4();
    await execute(
      "INSERT INTO subscriptions (id, user_id, package_id, amount, status, expires_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      [subId, req.user.id, packageId, pkg.price, expires]
    );

    const user = req.user;
    const payResult = await initiatePackagePayment({
      amount: pkg.price, phoneNumber: payerPhone,
      customer: { firstname: user.name.split(" ")[0], email: user.email },
      packageId, userId: user.id,
      idempotencyKey: idemKey("PKG", subId),
    });

    if (!payResult.success) {
      await execute("UPDATE subscriptions SET status = 'failed' WHERE id = ?", [subId]);
      return res.status(400).json({ error: payResult.message });
    }

    await execute("UPDATE subscriptions SET payment_ref = ? WHERE id = ?", [payResult.reference, subId]);
    res.json({ subscriptionId: subId, paymentRef: payResult.reference, status: "processing" });
  } catch (err) {
    res.status(500).json({ error: "Package purchase failed" });
  }
}

// POST /api/payment/withdraw  (seller or driver)
export async function requestWithdrawal(req, res) {
  try {
    const { amount, method, mobileNumber, accountNumber, accountName, bankName } = req.body;
    if (!amount || amount < 1000) return res.status(400).json({ error: "Minimum withdrawal is TZS 1,000" });

    const user = req.user;
    if (!["seller","driver"].includes(user.role)) return res.status(403).json({ error: "Only sellers and drivers can withdraw" });

    // Check balance
    let balRow;
    if (user.role === "seller") {
      balRow = await queryOne("SELECT balance FROM seller_profiles WHERE user_id = ?", [user.id]);
    } else {
      balRow = await queryOne("SELECT balance FROM driver_profiles WHERE user_id = ?", [user.id]);
    }
    if (!balRow || parseFloat(balRow.balance) < amount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const wdId = uuidv4();
    const isMobile = method === "mobile_money";

    await execute(
      `INSERT INTO withdrawals (id, user_id, user_role, amount, method, account_number, account_name, bank_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [wdId, user.id, user.role, amount, method || "mobile_money", mobileNumber || accountNumber || "", accountName || "", bankName || ""]
    );

    // Deduct balance optimistically
    const table = user.role === "seller" ? "seller_profiles" : "driver_profiles";
    await execute(`UPDATE ${table} SET balance = balance - ? WHERE user_id = ?`, [amount, user.id]);

    // Initiate payout via Snippe (mobile money only for now)
    if (isMobile && mobileNumber) {
      const payResult = await initiatePayout({
        amount, phoneNumber: mobileNumber,
        recipientName: accountName || user.name,
        description: `OneDelivery ${user.role} withdrawal`,
        idempotencyKey: idemKey("WD", wdId),
      });

      if (payResult.success) {
        await execute("UPDATE withdrawals SET snippe_payout_ref = ?, status = 'processing' WHERE id = ?", [payResult.reference, wdId]);
        return res.json({ message: "Withdrawal initiated. You'll receive funds shortly.", withdrawalId: wdId });
      }
      // If Snippe fails, revert balance and mark failed
      await execute(`UPDATE ${table} SET balance = balance + ? WHERE user_id = ?`, [amount, user.id]);
      await execute("UPDATE withdrawals SET status = 'failed', failure_reason = ? WHERE id = ?", [payResult.message, wdId]);
      return res.status(400).json({ error: payResult.message });
    }

    // Bank transfer: admin processes manually
    res.json({ message: "Withdrawal request submitted. Admin will process within 1–2 business days.", withdrawalId: wdId });
  } catch (err) {
    console.error("requestWithdrawal:", err.message);
    res.status(500).json({ error: "Withdrawal failed" });
  }
}

// GET /api/payment/withdrawals/my
export async function myWithdrawals(req, res) {
  try {
    const rows = await query(
      "SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      [req.user.id]
    );
    res.json({ withdrawals: rows });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Snippe Webhook ────────────────────────────────────────────────────────────
export async function snippeWebhook(req, res) {
  res.status(200).json({ received: true }); // Respond immediately

  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, req.headers)) {
      console.error("[webhook] Invalid Snippe signature");
      return;
    }

    const event = req.body;
    const data  = event.data;
    console.log("[webhook-debug] type=" + event.type + " reference=" + data?.reference + " external_reference=" + data?.external_reference + " metadata=" + JSON.stringify(data?.metadata));
    if (!data?.reference) return;

    // Idempotency: skip if already processed
    const dup = await queryOne("SELECT event_id FROM processed_webhooks WHERE event_id = ?", [event.id]);
    if (dup) return;
    await execute("INSERT INTO processed_webhooks (event_id) VALUES (?)", [event.id]);

    const meta = data.metadata || {};

    if (meta.type === "package")       await handlePackageWebhook(event.type, data);
    else if (meta.type === "delivery_fee") await handleDeliveryWebhook(event.type, data);
    else                               await handleOrderWebhook(event.type, data);

    // Cleanup old entries
    await execute("DELETE FROM processed_webhooks WHERE created_at < NOW() - INTERVAL 7 DAY");
  } catch (err) {
    console.error("[webhook] Error:", err.message);
  }
}

async function handleOrderWebhook(eventType, data) {
  const order = await queryOne("SELECT * FROM orders WHERE payment_ref = ?", [data.reference]);
  console.log("[webhook-debug] order lookup payment_ref=" + data.reference + " found=" + !!order + " orderId=" + (order ? order.id : null));
  if (!order) return;
  if (["success","failed"].includes(order.payment_status)) return;

  if (eventType === "payment.completed") {
    await execute("UPDATE orders SET status = 'pending', payment_status = 'success', paid_at = NOW() WHERE id = ?", [order.id]);
    // Credit seller balance
    if (order.seller_id) {
      const commission = 0.05; // 5% platform fee
      const sellerAmount = parseFloat(order.subtotal) * (1 - commission);
      await execute("UPDATE seller_profiles SET balance = balance + ?, total_sales = total_sales + ? WHERE user_id = ?",
        [sellerAmount, parseFloat(order.subtotal), order.seller_id]);
    }
    sendPushNotification(order.user_id, {
      title: "✅ Order Confirmed!",
      body: "Payment successful! Would you like delivery for your order?",
      type: "order_confirmed",
      data: { orderId: order.id, askForDelivery: true, screen: "order_detail" },
    }).catch(() => {});
  } else if (["payment.failed","payment.expired","payment.voided"].includes(eventType)) {
    const items = await query("SELECT product_id, quantity FROM order_items WHERE order_id = ?", [order.id]);
    await execute("UPDATE orders SET status = 'cancelled', payment_status = 'failed' WHERE id = ?", [order.id]);
    for (const item of items) {
      await execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.product_id]);
    }
    sendPushNotification(order.user_id, {
      title: "❌ Payment Failed", body: "Your payment was not successful. Please try again.",
      type: "payment_failed", data: { orderId: order.id },
    }).catch(() => {});
  }
}

async function handleDeliveryWebhook(eventType, data) {
  const ride = await queryOne("SELECT * FROM ride_requests WHERE delivery_payment_ref = ?", [data.reference]);
  if (!ride) return;
  if (eventType === "payment.completed") {
    await execute("UPDATE ride_requests SET delivery_fee_paid = 1 WHERE id = ?", [ride.id]);
    sendPushNotification(ride.customer_id, {
      title: "🚀 Delivery Payment Confirmed",
      body: "Finding a nearby driver for you...",
      type: "delivery_paid",
      data: { rideId: ride.id },
    }).catch(() => {});
  }
}

async function handlePackageWebhook(eventType, data) {
  const sub = await queryOne("SELECT * FROM subscriptions WHERE payment_ref = ?", [data.reference]);
  if (!sub) return;
  if (eventType === "payment.completed") {
    await execute("UPDATE subscriptions SET status = 'active', activated_at = NOW() WHERE id = ?", [sub.id]);
    sendPushNotification(sub.user_id, {
      title: "🎉 Package Activated!",
      body: "Your package is now active. Enjoy your benefits!",
      type: "package_activated",
      data: { packageId: sub.package_id },
    }).catch(() => {});
  } else if (["payment.failed","payment.expired"].includes(eventType)) {
    await execute("UPDATE subscriptions SET status = 'failed' WHERE id = ?", [sub.id]);
  }
}
