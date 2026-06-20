/**
 * services/turrets.js
 * Stellar Turrets txFunction server for automatic donation matching
 * 
 * This service implements a Turrets-compatible txFunction that:
 * 1. Listens for payments to project wallets
 * 2. Checks for active matching offers
 * 3. Submits pre-signed matching transactions from the matcher account
 */

const { Server, TransactionBuilder, Networks, Operation, Asset, Horizon } = require("@stellar/stellar-sdk");
const pool = require("../db/pool");
const { recordMatchingDonationCommand } = require("./accounting/commands");

// Network configuration
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const NETWORK_PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const HORIZON_URL = process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
let server;
function getServer() {
  if (!server) {
    server = new Server(HORIZON_URL);
  }
  return server;
}

/**
 * Turrets txFunction entry point for matching donations
 * This function is called by the Turret when a payment is detected
 */
async function matchDonationTxFunction(payment) {
  let client;

  try {
    const { 
      transaction_hash, 
      from, 
      to, 
      amount, 
      asset_code, 
      asset_type,
      memo 
    } = payment;

    if (asset_type !== "native" && asset_code !== "XLM") {
      console.log(`Skipping non-XLM donation: ${asset_code || asset_type}`);
      return { matched: false, reason: "Not an XLM donation" };
    }

    client = await pool.connect();

    const projectResult = await client.query(
      "SELECT id, name FROM projects WHERE wallet_address = $1",
      [to]
    );

    if (!projectResult.rows[0]) {
      console.log(`Project not found for wallet: ${to}`);
      return { matched: false, reason: "Project not found" };
    }

    const project = projectResult.rows[0];
    const donationAmount = parseFloat(amount);

    const matchesResult = await client.query(
      `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
       FROM donation_matches
       WHERE project_id = $1 AND expires_at > NOW()
       ORDER BY created_at ASC`,
      [project.id]
    );

    if (matchesResult.rows.length === 0) {
      console.log(`No active matching offers for project: ${project.id}`);
      return { matched: false, reason: "No active matching offers" };
    }

    let totalMatched = 0;
    const matchResults = [];

    for (const match of matchesResult.rows) {
      const matchedXlm = parseFloat(match.matched_xlm || "0");
      const capXlm = parseFloat(match.cap_xlm);
      const remaining = capXlm - matchedXlm;

      if (remaining <= 0) continue;

      const matchAmount = Math.min(donationAmount * match.multiplier, remaining);

      if (matchAmount <= 0) continue;

      const matchResult = await submitMatchingPayment({
        matcherAddress: match.matcher_address,
        projectWallet: to,
        amount: matchAmount,
        originalTxHash: transaction_hash,
        matchId: match.id,
        projectId: project.id
      });

      if (matchResult.success) {
        let dbClient;
        let inTransaction = false;

        try {
          dbClient = await pool.connect();
          await dbClient.query("BEGIN");
          inTransaction = true;

          const commandResult = await recordMatchingDonationCommand(dbClient, {
            projectId: project.id,
            matcherAddress: match.matcher_address,
            amountXLM: matchAmount.toFixed(7),
            originalTransactionHash: transaction_hash,
            originalDonorAddress: from,
            matchId: match.id,
            transactionHash: matchResult.txHash,
            message: `Matching donation for ${from}`,
            source: "turrets",
            metadata: { memo }
          });

          await dbClient.query("COMMIT");
          inTransaction = false;

          if (!commandResult.duplicate) {
            totalMatched += matchAmount;
          }

          matchResults.push({
            matchId: match.id,
            matcherAddress: match.matcher_address,
            amount: matchAmount,
            txHash: matchResult.txHash
          });
        } catch (error) {
          if (inTransaction && dbClient) await dbClient.query("ROLLBACK");
          console.error("Error recording matched donation:", error);
        } finally {
          if (dbClient) dbClient.release();
        }
      }
    }

    return {
      matched: totalMatched > 0,
      totalMatched,
      matches: matchResults,
      projectId: project.id,
      projectName: project.name
    };

  } catch (error) {
    console.error("Error in matchDonationTxFunction:", error);
    return { matched: false, error: error.message };
  } finally {
    if (client) client.release();
  }
}

/**
 * Submit a matching payment transaction
 * This uses pre-signed transactions from the matcher's account
 */
async function submitMatchingPayment({
  matcherAddress,
  projectWallet,
  amount,
  originalTxHash,
  matchId,
  projectId
}) {
  try {
    // Load the matcher account
    const matcherAccount = await getServer().loadAccount(matcherAddress);

    // Build the payment transaction
    const transaction = new TransactionBuilder(matcherAccount, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE
    })
      .addOperation(
        Operation.payment({
          destination: projectWallet,
          asset: Asset.native(),
          amount: amount.toFixed(7)
        })
      )
      .addMemo(
        Operation.memo({
          type: "text",
          value: `Match:${originalTxHash.slice(0, 20)}`
        })
      )
      .setTimeout(60)
      .build();

    // In a real implementation, this would use pre-signed transactions
    // For now, we'll need the matcher's secret key to sign
    // This should be stored securely (e.g., in environment variables or a secret manager)
    const matcherSecret = process.env.MATCHER_SECRET_KEY;
    
    if (!matcherSecret) {
      console.warn("MATCHER_SECRET_KEY not configured. Cannot submit matching payment.");
      return { success: false, reason: "Matcher secret not configured" };
    }

    // Sign the transaction
    transaction.sign(require("@stellar/stellar-sdk").Keypair.fromSecret(matcherSecret));

    // Submit to Horizon
    const result = await getServer().submitTransaction(transaction);

    console.log(`Matching payment submitted: ${result.hash}`);

    return {
      success: true,
      txHash: result.hash
    };

  } catch (error) {
    console.error("Error submitting matching payment:", error);
    return { success: false, error: error.message };
  }
}

/**
 * Generate pre-signed transactions for a matcher up to a cap
 * This allows the Turret to submit transactions without needing the secret key at runtime
 */
async function generatePreSignedTransactions({
  matcherAddress,
  matcherSecret,
  projectWallet,
  capXlm,
  multiplier,
  projectId
}) {
  const transactions = [];
  const matcherKeypair = require("@stellar/stellar-sdk").Keypair.fromSecret(matcherSecret);
  
  // Generate transactions for different donation amounts
  const donationAmounts = [10, 25, 50, 100, 250];
  
  for (const donationAmount of donationAmounts) {
    const matchAmount = Math.min(donationAmount * multiplier, capXlm);
    
    if (matchAmount <= 0) continue;

    try {
      const account = await getServer().loadAccount(matcherAddress);
      
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: NETWORK_PASSPHRASE
      })
        .addOperation(
          Operation.payment({
            destination: projectWallet,
            asset: Asset.native(),
            amount: matchAmount.toFixed(7)
          })
        )
        .setTimeout(60)
        .build();

      tx.sign(matcherKeypair);
      
      transactions.push({
        donationAmount,
        matchAmount,
        xdr: tx.toXDR()
      });
    } catch (error) {
      console.error(`Error generating transaction for ${donationAmount} XLM:`, error);
    }
  }

  return transactions;
}

/**
 * Start the Turrets server
 * This creates an HTTP server that Turrets can call
 */
function startTurretsServer(port = 3001) {
  const express = require("express");
  const app = express();

  app.use(express.json());
  app.use(require("cors")());

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "turrets-matching" });
  });

  // txFunction endpoint for matching donations
  app.post("/txfunction/matchDonation", async (req, res) => {
    try {
      const result = await matchDonationTxFunction(req.body);
      res.json(result);
    } catch (error) {
      console.error("Error in txFunction:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint to generate pre-signed transactions
  app.post("/admin/presign", async (req, res) => {
    try {
      const {
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm,
        multiplier,
        projectId
      } = req.body;

      if (!matcherAddress || !matcherSecret || !projectWallet) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      const transactions = await generatePreSignedTransactions({
        matcherAddress,
        matcherSecret,
        projectWallet,
        capXlm: parseFloat(capXlm),
        multiplier: parseFloat(multiplier),
        projectId
      });

      res.json({ success: true, transactions });
    } catch (error) {
      console.error("Error generating pre-signed transactions:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.listen(port, () => {
    console.log(`Turrets server listening on port ${port}`);
  });

  return app;
}

module.exports = {
  matchDonationTxFunction,
  submitMatchingPayment,
  generatePreSignedTransactions,
  startTurretsServer
};
