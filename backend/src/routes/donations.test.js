"use strict";

jest.mock("../db/pool", () => ({
  connect: jest.fn(),
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

const pool = require("../db/pool");
const { computeBadges } = require("../services/store");
const { recordDonation } = require("./donations");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return { rows };
}

function eventRow({ transactionHash, donationId = "donation-event-1", donorAddress, amountXLM = "10" }) {
  return {
    id: "event-1",
    event_type: "DonationRecorded",
    aggregate_type: "donation",
    aggregate_id: donationId,
    aggregate_version: "1",
    sequence: "1",
    occurred_at: "2026-03-29T10:00:00.000Z",
    payload: {
      donationId,
      projectId: "project-1",
      donorAddress,
      amountXLM,
      amount: amountXLM,
      currency: "XLM",
      message: null,
      transactionHash,
      createdAt: "2026-03-29T10:00:00.000Z",
      source: "test",
    },
    metadata: {},
  };
}

function createMockClient({
  donationRow,
  existingEvent,
  existingProfile,
  matches = [],
  projectsSupportedCount = "1",
  throwOnSql,
} = {}) {
  let sequence = 1;
  const client = {
    query: jest.fn(async (sql) => {
      if (throwOnSql && sql.includes(throwOnSql)) {
        throw new Error("profile write failed");
      }

      if (sql.includes("SELECT id FROM projects")) {
        return queryResult([{ id: "project-1" }]);
      }

      if (sql.includes("payload->>'transactionHash'")) {
        return existingEvent ? queryResult([existingEvent]) : queryResult([]);
      }

      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return queryResult();
      }

      if (sql.includes("SELECT COALESCE(MAX(aggregate_version)")) {
        return queryResult([{ version: "0" }]);
      }

      if (sql.includes("INSERT INTO ledger_events")) {
        return queryResult([{ sequence: String(sequence++) }]);
      }

      if (sql.includes("SELECT 1") && sql.includes("ledger_projection_events")) {
        return queryResult([]);
      }

      if (sql.includes("INSERT INTO donations")) {
        return queryResult([donationRow || {
          id: "donation-1",
          project_id: "project-1",
          donor_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB",
          amount_xlm: "10",
          amount: "10",
          currency: "XLM",
          message: null,
          transaction_hash: makeTxHash("a"),
          created_at: "2026-03-29T10:00:00.000Z",
        }]);
      }

      if (sql.includes("UPDATE projects")) {
        return queryResult();
      }

      if (sql.includes("SELECT public_key, display_name, bio")) {
        return existingProfile ? queryResult([existingProfile]) : queryResult([]);
      }

      if (sql.includes("SELECT COUNT(DISTINCT project_id) AS count")) {
        return queryResult([{ count: projectsSupportedCount }]);
      }

      if (sql.includes("INSERT INTO profiles")) {
        return queryResult();
      }

      if (sql.includes("INSERT INTO account_balances")) {
        return queryResult();
      }

      if (sql.includes("INSERT INTO ledger_projection_events")) {
        return queryResult();
      }

      if (sql.includes("SELECT id, matcher_address")) {
        return queryResult(matches);
      }

      return queryResult();
    }),
    release: jest.fn(),
  };

  pool.connect.mockResolvedValue(client);
  return client;
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeRecordDonation(body) {
  const req = { body };
  const res = createMockResponse();
  const next = jest.fn((err) => {
    if (err) {
      res.status(err.status || 500).json({ error: err.message || "Internal server error" });
    }
  });

  await recordDonation(req, res, next);
  return { req, res, next };
}

function expectBadge(totalXLM, tier) {
  const badges = computeBadges(totalXLM);

  if (!tier) {
    expect(badges).toEqual([]);
    return;
  }

  expect(badges).toEqual([
    expect.objectContaining({
      tier,
      earnedAt: expect.any(String),
    }),
  ]);
}

function findQueryCall(client, snippet) {
  return client.query.mock.calls.find(([sql]) => sql.includes(snippet));
}

describe("donations route badge calculation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("awards no badge at 0 XLM", () => {
    expectBadge(0, null);
  });

  test("awards no badge at 9 XLM", () => {
    expectBadge(9, null);
  });

  test("awards Seedling at 10 XLM", () => {
    expectBadge(10, "seedling");
  });

  test("keeps Seedling at 99 XLM", () => {
    expectBadge(99, "seedling");
  });

  test("awards Tree at 100 XLM", () => {
    expectBadge(100, "tree");
  });

  test("keeps Tree at 499 XLM", () => {
    expectBadge(499, "tree");
  });

  test("awards Forest at 500 XLM", () => {
    expectBadge(500, "forest");
  });

  test("keeps Forest at 1999 XLM", () => {
    expectBadge(1999, "forest");
  });

  test("awards Earth Guardian at 2000 XLM", () => {
    expectBadge(2000, "earth");
  });
});

describe("POST /api/donations", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("records a valid donation and updates the donor profile", async () => {
    const donorAddress = makePublicKey("A");
    const transactionHash = makeTxHash("a");
    const client = createMockClient();

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "10",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        projectId: "project-1",
        donorAddress,
        amountXLM: "10.0000000",
        amount: "10",
        currency: "XLM",
        transactionHash,
      }),
    );
    expect(client.release).toHaveBeenCalledTimes(1);

    const profileUpsertCall = findQueryCall(client, "INSERT INTO profiles");
    expect(profileUpsertCall[1][0]).toBe(donorAddress);
    expect(profileUpsertCall[1][3]).toBe("10.0000000");
    expect(profileUpsertCall[1][4]).toBe(1);
    expect(JSON.parse(profileUpsertCall[1][5])).toEqual([
      expect.objectContaining({ tier: "seedling", earnedAt: expect.any(String) }),
    ]);
  });

  test("returns 404 for an unknown project id", async () => {
    const client = createMockClient({ donationRow: null });
    client.query.mockImplementationOnce(async () => queryResult([]));

    const { res, next } = await invokeRecordDonation({
      projectId: "missing-project",
      donorAddress: makePublicKey("B"),
      amountXLM: "15",
      transactionHash: makeTxHash("b"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe("Project not found");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for an invalid public key", async () => {
    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress: "not-a-stellar-key",
      amountXLM: "15",
      transactionHash: makeTxHash("c"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid Stellar public key");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("returns 400 for an invalid transaction hash", async () => {
    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress: makePublicKey("C"),
      amountXLM: "15",
      transactionHash: "bad-hash",
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid transaction hash");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test("deduplicates duplicate transaction hashes and returns the existing record", async () => {
    const donorAddress = makePublicKey("D");
    const transactionHash = makeTxHash("d");
    const existingEvent = eventRow({
      transactionHash,
      donationId: "donation-existing",
      donorAddress,
      amountXLM: "25",
    });
    const client = createMockClient({ existingEvent });

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "25",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        id: "donation-existing",
        transactionHash,
        amountXLM: "25.0000000",
      }),
    );
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test("updates project totals after a donation", async () => {
    const client = createMockClient();

    const { res, next } = await invokeRecordDonation({
      projectId: "project-2",
      donorAddress: makePublicKey("E"),
      amountXLM: "5.5",
      transactionHash: makeTxHash("e"),
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);

    const updateProjectCall = findQueryCall(client, "UPDATE projects");
    expect(updateProjectCall[1]).toEqual([5.5, "project-2"]);
  });

  test("calculates badges from cumulative donations across multiple requests", async () => {
    const donorAddress = makePublicKey("F");
    const client = createMockClient({
      existingProfile: {
        public_key: donorAddress,
        display_name: "Existing Donor",
        bio: "Already donated before",
        total_donated_xlm: "99.0000000",
      },
      projectsSupportedCount: "3",
    });

    const { res, next } = await invokeRecordDonation({
      projectId: "project-3",
      donorAddress,
      amountXLM: "1",
      transactionHash: makeTxHash("f"),
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);

    const profileUpsertCall = findQueryCall(client, "INSERT INTO profiles");
    expect(profileUpsertCall[1][3]).toBe("100.0000000");
    expect(profileUpsertCall[1][4]).toBe(3);
    expect(JSON.parse(profileUpsertCall[1][5])).toEqual([
      expect.objectContaining({ tier: "tree", earnedAt: expect.any(String) }),
    ]);
  });

  test("rolls back the transaction if profile persistence fails after BEGIN", async () => {
    const client = createMockClient({ throwOnSql: "INSERT INTO profiles" });

    const { res, next } = await invokeRecordDonation({
      projectId: "project-4",
      donorAddress: makePublicKey("G"),
      amountXLM: "12",
      transactionHash: makeTxHash("a"),
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe("profile write failed");
    expect(res.statusCode).toBe(500);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
