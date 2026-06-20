/**
 * backend/src/services/indexerService.js
 */
"use strict";

const { server: stellarServer } = require("./stellar");
const pool = require("../db/pool");
const { recordDonationCommand } = require("./accounting/commands");

let lastProcessedLedger = 0;
let lastReconciledLedger = 0;
let isRunning = false;
let isReconciling = false;
let io = null;
let projectWallets = new Map(); // wallet_address -> project_id

async function updateProjectWallets() {
  try {
    const result = await pool.query("SELECT id, wallet_address FROM projects WHERE status = 'active'");
    projectWallets.clear();
    for (const row of result.rows) {
      projectWallets.set(row.wallet_address, row.id);
    }
    console.log(`[Indexer] Updated cache with ${projectWallets.size} project wallets.`);
  } catch (err) {
    console.error("[Indexer] Failed to update project wallets cache:", err.message);
  }
}

async function reconcileDonations() {
  if (isReconciling || projectWallets.size === 0) return;
  isReconciling = true;

  const client = await pool.connect();
  try {
    let startLedger = lastReconciledLedger;
    if (startLedger === 0) {
      const latestResult = await stellarServer.ledgers().order("desc").limit(1).call();
      startLedger = parseInt(latestResult.records[0].sequence) - 1000;
    }
    const currentLedgerResult = await stellarServer.ledgers().order("desc").limit(1).call();
    const currentLedger = parseInt(currentLedgerResult.records[0].sequence);

    for (const [walletAddress, projectId] of projectWallets) {
      let payments;
      try {
        payments = await stellarServer.payments()
          .forAccount(walletAddress)
          .startLedger(startLedger + 1)
          .limit(200)
          .call();
      } catch (e) {
        console.error(`[Reconciler] Failed to query payments for ${walletAddress}:`, e.message);
        continue;
      }

      for (const payment of payments.records) {
        if (payment.asset_type !== "native") continue;

        const txHash = payment.transaction_hash;
        const donorAddress = payment.from;
        const amountXLM = parseFloat(payment.amount);

        try {
          await client.query("BEGIN");
          const commandResult = await recordDonationCommand(client, {
            projectId,
            donorAddress,
            amountXLM: amountXLM.toFixed(7),
            transactionHash: txHash,
            source: "indexer-reconcile",
          });
          await client.query("COMMIT");

          if (!commandResult.duplicate) {
            console.log(`[Reconciler] Found missing donation: ${amountXLM} XLM to project ${projectId}`);
          }
        } catch (e) {
          await client.query("ROLLBACK");
          console.error("[Reconciler] Failed to record donation:", e.message);
        }
      }
    }
    lastReconciledLedger = currentLedger;
  } catch (err) {
    console.error("[Reconciler] Error during reconciliation:", err.message);
  } finally {
    client.release();
    isReconciling = false;
  }
}

/**
 * Start the Stellar indexer service.
 * @param {Object} socketIo - The Socket.io server instance.
 */
async function startIndexer(socketIo) {
  if (isRunning) return;
  isRunning = true;
  io = socketIo;

  await updateProjectWallets();
  // Refresh cache every 10 minutes
  setInterval(updateProjectWallets, 10 * 60 * 1000);

  // Run reconciliation every 15 minutes
  setInterval(reconcileDonations, 15 * 60 * 1000).unref();

  console.log("[Indexer] Starting Horizon operations stream...");

  // Start streaming operations from 'now'
  stellarServer.operations()
    .cursor("now")
    .stream({
      onmessage: async (op) => {
        try {
          lastProcessedLedger = op.ledger_attr;

          // We only care about XLM payments
          if (op.type === "payment" && op.asset_type === "native") {
            const projectId = projectWallets.get(op.to);
            if (projectId) {
              await handleDonation(projectId, op);
            }
          }
        } catch (err) {
          console.error("[Indexer] Error processing operation:", err.message);
        }
      },
      onerror: (err) => {
        console.error("[Indexer] Stream error:", err);
      }
    });
}

/**
 * Handle a payment to a project.
 */
async function handleDonation(projectId, op) {
  const txHash = op.transaction_hash;
  const donorAddress = op.from;
  const amountXLM = parseFloat(op.amount);

  const client = await pool.connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;

    const commandResult = await recordDonationCommand(client, {
      projectId,
      donorAddress,
      amountXLM: amountXLM.toFixed(7),
      transactionHash: txHash,
      source: "indexer-stream",
    });

    await client.query("COMMIT");
    inTransaction = false;

    console.log(`[Indexer] New donation: ${amountXLM} XLM from ${donorAddress} to project ${projectId}`);

    if (io && !commandResult.duplicate) {
      io.emit("newDonation", {
        projectId,
        donorAddress,
        amountXLM,
        txHash,
        timestamp: new Date().toISOString()
      });
    }
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK");
    console.error("[Indexer] Failed to process donation:", err.message);
  } finally {
    client.release();
  }
}

/**
 * Returns the indexer status for the health endpoint.
 */
function getStatus() {
  return {
    isRunning,
    lastProcessedLedger,
    projectWalletsCount: projectWallets.size,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  startIndexer,
  getStatus,
  reconcileDonations
};
