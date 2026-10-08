import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { uploadImage } from "../middleware/upload.middleware.js";
import { myConversations, getMessages, startConversation, sendMessage, unreadCount, chatContacts } from "../controllers/chat.controller.js";

const router = Router();

router.get ("/contacts",                   authenticate, chatContacts);
router.get ("/conversations",              authenticate, myConversations);
router.post("/conversations",              authenticate, startConversation);
router.get ("/conversations/:id/messages", authenticate, getMessages);
router.post("/conversations/:id/messages", authenticate, uploadImage.single("image"), sendMessage);
router.get ("/unread",                     authenticate, unreadCount);

export default router;
