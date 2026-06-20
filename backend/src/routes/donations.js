/**
 * src/routes/donations.js
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { mapDonationRow } = require("../services/store");
const {
  donationFromEvent,
  recordDonationCommand,
} = require("../services/accounting/commands");
const {
  findEventByTransactionHash,
  getAccountStateAt,
} = require("../services/accounting/eventStore");

const donationLimiter = createRateLimiter(10, 1);

function validateKey(k) {
  if (!k || !/^G[A-Z0-9]{55}$/.test(k)) {
    const e = new Error("Invalid Stellar public key");
    e.status = 400;
    throw e;
  }
}

function validateTxHash(h) {
  if (!h || !/^[a-fA-F0-9]{64}$/.test(h)) {
    const e = new Error("Invalid transaction hash");
    e.status = 400;
    throw e;
  }
}

// POST /api/donations — record a donation after on-chain tx
async function recordDonation(req, res, next) {
  let client;
  let inTransaction = false;

  try {
    const { projectId, donorAddress, amountXLM, amount, currency = "XLM", message, transactionHash } = req.body;
    validateKey(donorAddress);
    validateTxHash(transactionHash);

    client = await pool.connect();

    const projectResult = await client.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!projectResult.rows[0]) {
      const e = new Error("Project not found");
      e.status = 404;
      throw e;
    }

    const existingEvent = await findEventByTransactionHash(client, transactionHash);
    if (existingEvent) {
      return res.json({ success: true, data: donationFromEvent(existingEvent) });
    }

    await client.query("BEGIN");
    inTransaction = true;

    const commandResult = await recordDonationCommand(client, {
      projectId,
      donorAddress,
      amountXLM,
      amount,
      currency,
      message,
      transactionHash,
      source: "api",
    });

    await client.query("COMMIT");
    inTransaction = false;

    const io = req.app?.get("io");
    if (io) {
      io.emit("donation_event", {
        projectId,
        donorAddress,
        amountXLM: commandResult.donation.amountXLM,
        transactionHash,
        timestamp: new Date().toISOString(),
      });
    }

    res.status(commandResult.duplicate ? 200 : 201).json({
      success: true,
      data: commandResult.donation,
    });
  } catch (e) {
    if (inTransaction && client) await client.query("ROLLBACK");
    next(e);
  } finally {
    if (client) client.release();
  }
}

router.post("/", donationLimiter, recordDonation);

// GET /api/donations/project/:id
router.get("/project/:projectId/messages", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const result = await pool.query(
      `SELECT *
       FROM donations
       WHERE project_id = $1
         AND message IS NOT NULL
         AND length(trim(message)) > 0
       ORDER BY amount DESC, created_at DESC
       LIMIT $2`,
      [req.params.projectId, limit],
    );
    res.json({ success: true, data: result.rows.map(mapDonationRow) });
  } catch (e) {
    next(e);
  }
});

router.get("/project/:projectId", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const hasCursor = Boolean(req.query.cursor);
    const values = hasCursor
      ? [req.params.projectId, req.query.cursor, limit + 1]
      : [req.params.projectId, limit + 1];

    const query = hasCursor
      ? `SELECT * FROM donations
         WHERE project_id = $1
           AND created_at < $2::timestamptz
         ORDER BY created_at DESC
         LIMIT $3`
      : `SELECT * FROM donations
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2`;

    const donations = (await pool.query(query, values)).rows.map(mapDonationRow);
    const hasMore = donations.length > limit;
    const result = hasMore ? donations.slice(0, limit) : donations;
    const nextCursor = hasMore ? result[result.length - 1].createdAt : null;

    res.json({ success: true, data: result, nextCursor });
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/donor/:publicKey/state
router.get("/donor/:publicKey/state", async (req, res, next) => {
  try {
    validateKey(req.params.publicKey);

    const asOf = req.query.asOf ? new Date(req.query.asOf) : null;
    if (req.query.asOf && Number.isNaN(asOf.getTime())) {
      const e = new Error("Invalid asOf timestamp");
      e.status = 400;
      throw e;
    }

    const state = await getAccountStateAt(pool, "donation", req.params.publicKey, asOf ? asOf.toISOString() : null, "donor");
    res.json({ success: true, data: state });
  } catch (e) {
    next(e);
  }
});

// GET /api/donations/donor/:publicKey
router.get("/donor/:publicKey", async (req, res, next) => {
  try {
    validateKey(req.params.publicKey);
    const result = await pool.query(
      `SELECT * FROM donations
       WHERE donor_address = $1
       ORDER BY created_at DESC`,
      [req.params.publicKey],
    );
    res.json({ success: true, data: result.rows.map(mapDonationRow) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.recordDonation = recordDonation;
