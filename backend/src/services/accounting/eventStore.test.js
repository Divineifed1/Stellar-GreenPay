"use strict";

const { getAccountStateAt } = require("./eventStore");

const donorAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMB";
const projectId = "project-1";

function eventRow({ sequence, eventType, amountXLM, occurredAt = "2026-03-29T10:00:00.000Z" }) {
  return {
    id: `event-${sequence}`,
    event_type: eventType,
    aggregate_type: "donation",
    aggregate_id: `donation-${sequence}`,
    aggregate_version: "1",
    sequence: String(sequence),
    occurred_at: occurredAt,
    payload: {
      donationId: `donation-${sequence}`,
      projectId,
      donorAddress,
      amountXLM,
      amount: amountXLM,
      currency: "XLM",
      message: null,
      transactionHash: `tx-${sequence}`,
      createdAt: occurredAt,
      source: "test",
    },
    metadata: {},
  };
}

describe("accounting event store queries", () => {
  test("reconstructs donor account state at a historical point in time", async () => {
    const client = {
      query: jest.fn(async () => ({
        rows: [
          eventRow({ sequence: 1, eventType: "DonationRecorded", amountXLM: "10", occurredAt: "2026-03-29T10:00:00.000Z" }),
          eventRow({ sequence: 2, eventType: "DonationRecorded", amountXLM: "25", occurredAt: "2026-03-30T10:00:00.000Z" }),
          eventRow({ sequence: 3, eventType: "DonationRecorded", amountXLM: "5", occurredAt: "2026-03-31T10:00:00.000Z" }),
        ],
      })),
    };

    const state = await getAccountStateAt(
      client,
      "donation",
      donorAddress,
      "2026-03-30T12:00:00.000Z",
      "donor",
    );

    expect(state).toEqual({
      accountType: "donor",
      accountId: donorAddress,
      asOf: "2026-03-30T12:00:00.000Z",
      balanceXLM: "-35.0000000",
      totalDonatedXLM: "35.0000000",
      projectsSupported: 1,
      donationCount: 2,
      donations: [
        expect.objectContaining({ id: "donation-1", amountXLM: "10.0000000" }),
        expect.objectContaining({ id: "donation-2", amountXLM: "25.0000000" }),
      ],
    });
  });

  test("includes matching donation events in reconstructed account state", async () => {
    const client = {
      query: jest.fn(async () => ({
        rows: [
          eventRow({ sequence: 1, eventType: "DonationRecorded", amountXLM: "10" }),
          eventRow({ sequence: 2, eventType: "MatchingDonationRecorded", amountXLM: "5" }),
        ],
      })),
    };

    const state = await getAccountStateAt(client, "donation", donorAddress, null, "donor");

    expect(state.balanceXLM).toBe("-15.0000000");
    expect(state.totalDonatedXLM).toBe("15.0000000");
    expect(state.donationCount).toBe(2);
  });
});
