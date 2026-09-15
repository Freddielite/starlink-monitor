import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { generateToken, hashToken } from "../lib/apiTokens.js";

const router = Router();
router.use(requireAuth);

// Never returns token_hash - there's no legitimate reason for the
// frontend to ever see it, hashed or not.
router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, token_prefix, last_used_at, created_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.userId]
  );
  res.json(rows);
});

router.post("/", async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const token = generateToken();
  const { rows } = await pool.query(
    `INSERT INTO api_tokens (user_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4) RETURNING id, name, token_prefix, last_used_at, created_at`,
    [req.userId, name.trim(), hashToken(token), token.slice(0, 13)]
  );
  // The one and only time the raw token is ever sent anywhere - it's not
  // stored, so this response is the person's only chance to copy it.
  res.status(201).json({ ...rows[0], token });
});

router.delete("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM api_tokens WHERE id = $1 AND user_id = $2 RETURNING id`,
    [req.params.id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "token not found" });
  res.json({ ok: true });
});

export default router;
