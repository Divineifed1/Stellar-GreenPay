"use strict";

jest.mock("../db/pool", () => ({ connect: jest.fn() }));
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

const http = require("http");
const express = require("express");
const { Server: SocketServer } = require("socket.io");
const { io: ioc } = require("socket.io-client");
const supertest = require("supertest");
const pool = require("../db/pool");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return { rows };
}

function createMockClient({ donationRow, existingEvent } = {}) {
  let sequence = 1;
  const client = {
    query: jest.fn(async (sql) => {
      if (sql.includes("SELECT id FROM projects")) {
        return queryResult([{ id: "project-ws" }]);
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
          id: "socket-donation-1",
          project_id: "project-ws",
          donor_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB",
          amount_xlm: "25",
          amount: "25",
          currency: "XLM",
          message: null,
          transaction_hash: makeTxHash("a"),
          created_at: new Date().toISOString(),
        }]);
      }

      if (sql.includes("UPDATE projects")) {
        return queryResult();
      }

      if (sql.includes("SELECT public_key, display_name, bio")) {
        return queryResult([]);
      }

      if (sql.includes("SELECT COUNT(DISTINCT project_id) AS count")) {
        return queryResult([{ count: "1" }]);
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
        return queryResult([]);
      }

      return queryResult();
    }),
    release: jest.fn(),
  };

  pool.connect.mockResolvedValue(client);
  return client;
}

describe("POST /api/donations → donation_event WebSocket broadcast", () => {
  let httpServer;
  let ioServer;
  let request;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    httpServer = http.createServer(app);
    ioServer = new SocketServer(httpServer, {
      cors: { origin: "*" },
      transports: ["websocket"],
    });
    app.set("io", ioServer);
    app.use("/api/donations", require("./donations"));

    httpServer.listen(0, () => {
      const { port } = httpServer.address();
      baseUrl = `http://localhost:${port}`;
      request = supertest(httpServer);
      done();
    });
  });

  afterAll((done) => {
    ioServer.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test(
    "emits donation_event to connected clients within 500 ms",
    (done) => {
      const donorAddress = makePublicKey("W");
      const transactionHash = makeTxHash("7");
      const donationRow = {
        id: "socket-donation-1",
        project_id: "project-ws",
        donor_address: donorAddress,
        amount_xlm: "25",
        amount: "25",
        currency: "XLM",
        message: null,
        transaction_hash: transactionHash,
        created_at: new Date().toISOString(),
      };

      createMockClient({ donationRow });

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      const deadline = setTimeout(() => {
        socket.disconnect();
        done(new Error("donation_event was not received within 500 ms"));
      }, 500);

      socket.on("connect", () => {
        socket.on("donation_event", (data) => {
          clearTimeout(deadline);
          socket.disconnect();
          try {
            expect(data.projectId).toBe("project-ws");
            expect(data.donorAddress).toBe(donorAddress);
            expect(data.transactionHash).toBe(transactionHash);
            expect(typeof data.timestamp).toBe("string");
            done();
          } catch (assertionError) {
            done(assertionError);
          }
        });

        request
          .post("/api/donations")
          .send({
            projectId: "project-ws",
            donorAddress,
            amountXLM: "25",
            transactionHash,
          })
          .end((err) => {
            if (err) {
              clearTimeout(deadline);
              socket.disconnect();
              done(err);
            }
          });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(deadline);
        done(err);
      });
    },
    2000,
  );

  test(
    "does not emit donation_event when the project is not found",
    (done) => {
      const donorAddress = makePublicKey("X");
      const transactionHash = makeTxHash("8");
      const client = createMockClient();
      client.query.mockImplementationOnce(async () => queryResult([]));

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      let eventReceived = false;

      socket.on("connect", () => {
        socket.on("donation_event", () => {
          eventReceived = true;
        });

        request
          .post("/api/donations")
          .send({
            projectId: "nonexistent-project",
            donorAddress,
            amountXLM: "10",
            transactionHash,
          })
          .end((err, res) => {
            socket.disconnect();
            if (err) return done(err);
            try {
              expect(res.status).toBe(404);
              expect(eventReceived).toBe(false);
              done();
            } catch (assertionError) {
              done(assertionError);
            }
          });
      });

      socket.on("connect_error", (err) => done(err));
    },
    2000,
  );

  test(
    "includes correct amountXLM in the donation_event payload",
    (done) => {
      const donorAddress = makePublicKey("Y");
      const transactionHash = makeTxHash("9");
      const donationRow = {
        id: "socket-donation-2",
        project_id: "project-ws-2",
        donor_address: donorAddress,
        amount_xlm: "100",
        amount: "100",
        currency: "XLM",
        message: null,
        transaction_hash: transactionHash,
        created_at: new Date().toISOString(),
      };

      createMockClient({ donationRow });

      const socket = ioc(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
      });

      const deadline = setTimeout(() => {
        socket.disconnect();
        done(new Error("donation_event was not received within 500 ms"));
      }, 500);

      socket.on("connect", () => {
        socket.on("donation_event", (data) => {
          clearTimeout(deadline);
          socket.disconnect();
          try {
            expect(data.amountXLM).toBe("100.0000000");
            done();
          } catch (assertionError) {
            done(assertionError);
          }
        });

        request
          .post("/api/donations")
          .send({
            projectId: "project-ws-2",
            donorAddress,
            amountXLM: "100",
            transactionHash,
          })
          .end((err) => {
            if (err) {
              clearTimeout(deadline);
              socket.disconnect();
              done(err);
            }
          });
      });

      socket.on("connect_error", (err) => {
        clearTimeout(deadline);
        done(err);
      });
    },
    2000,
  );
});
