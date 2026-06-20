"use strict";

const { v4: uuid } = require("uuid");
const {
  EVENT_TYPES,
  appendEvent,
  findEventByTransactionHash,
  formatXlm,
} = require("./eventStore");
const { applyAccountingEvent } = require("./projections");

function parseAmount(input) {
  const amount = Number.parseFloat(input);
  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("Invalid amount");
    error.status = 400;
    throw error;
  }

  return amount;
}

function donationFromEvent(event) {
  const payload = event.payload;
  const data = {
    id: payload.donationId,
    projectId: payload.projectId,
    donorAddress: payload.donorAddress,
    amount: payload.amount?.toString() || "0",
    currency: payload.currency,
    message: payload.message || null,
    transactionHash: payload.transactionHash,
    createdAt: payload.createdAt ? new Date(payload.createdAt).toISOString() : event.occurredAt,
  };

  if (payload.currency === "XLM" && payload.amountXLM !== null && payload.amountXLM !== undefined) {
    data.amountXLM = formatXlm(payload.amountXLM);
  }

  return data;
}

function createDonationRecordedEvent(input, donationId, createdAt, parsedAmount) {
  const currency = input.currency || "XLM";
  const amount = parsedAmount ?? parseAmount(input.amountXLM ?? input.amount);

  return {
    id: input.eventId || uuid(),
    type: EVENT_TYPES.DONATION_RECORDED,
    aggregateType: "donation",
    aggregateId: donationId,
    occurredAt: createdAt,
    payload: {
      donationId,
      projectId: input.projectId,
      donorAddress: input.donorAddress,
      amountXLM: currency === "XLM" ? formatXlm(amount) : null,
      amount: amount.toString(),
      currency,
      message: input.message?.trim().slice(0, 100) || null,
      transactionHash: input.transactionHash,
      createdAt,
      source: input.source || "api",
    },
    metadata: input.metadata || {},
  };
}

function createMatchingDonationRecordedEvent(input, donationId, createdAt, amount) {
  return {
    id: input.eventId || uuid(),
    type: EVENT_TYPES.MATCHING_DONATION_RECORDED,
    aggregateType: "donation",
    aggregateId: donationId,
    occurredAt: createdAt,
    payload: {
      donationId,
      projectId: input.projectId,
      donorAddress: input.matcherAddress,
      matcherAddress: input.matcherAddress,
      matchId: input.matchId,
      originalTransactionHash: input.originalTransactionHash,
      amountXLM: formatXlm(amount),
      amount: amount.toString(),
      currency: "XLM",
      message: input.message || `Matching donation for ${input.originalDonorAddress}`,
      transactionHash: input.transactionHash,
      createdAt,
      source: input.source || "matching",
    },
    metadata: input.metadata || {},
  };
}

async function persistEvent(client, event) {
  const storedEvent = await appendEvent(client, event);
  await applyAccountingEvent(client, storedEvent);
  return storedEvent;
}

async function loadActiveMatches(client, projectId) {
  const result = await client.query(
    `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
     FROM donation_matches
     WHERE project_id = $1 AND expires_at > NOW()
     ORDER BY created_at ASC`,
    [projectId],
  );

  return result.rows;
}

async function recordDonationCommand(client, input) {
  const existingEvent = await findEventByTransactionHash(client, input.transactionHash);
  if (existingEvent) {
    return {
      duplicate: true,
      donation: donationFromEvent(existingEvent),
      events: [existingEvent],
      matchingDonations: [],
    };
  }

  const donationId = input.donationId || uuid();
  const createdAt = input.createdAt || new Date().toISOString();
  const currency = input.currency || "XLM";
  const parsedAmount = parseAmount(currency === "XLM" ? input.amountXLM ?? input.amount : input.amount);
  const primaryEvent = createDonationRecordedEvent(
    {
      ...input,
      currency,
      eventId: input.primaryEventId,
    },
    donationId,
    createdAt,
    parsedAmount,
  );
  const storedPrimaryEvent = await persistEvent(client, primaryEvent);
  const events = [storedPrimaryEvent];
  const matchingDonations = [];

  if (input.recordMatches !== false && currency === "XLM") {
    const matches = await loadActiveMatches(client, input.projectId);

    for (const match of matches) {
      const matchedXlm = Number.parseFloat(match.matched_xlm || "0");
      const capXlm = Number.parseFloat(match.cap_xlm);
      const remaining = capXlm - matchedXlm;

      if (remaining <= 0) continue;

      const matchAmount = Math.min(parsedAmount * match.multiplier, remaining);
      if (matchAmount <= 0) continue;

      const matchingEvent = createMatchingDonationRecordedEvent(
        {
          projectId: input.projectId,
          donorAddress: match.matcher_address,
          matcherAddress: match.matcher_address,
          matchId: match.id,
          originalTransactionHash: input.transactionHash,
          originalDonorAddress: input.donorAddress,
          amount: parsedAmount,
          transactionHash: `match-${input.transactionHash}-${match.id}`,
          source: "api",
        },
        uuid(),
        createdAt,
        matchAmount,
      );
      const storedMatchingEvent = await persistEvent(client, matchingEvent);
      events.push(storedMatchingEvent);
      matchingDonations.push(donationFromEvent(storedMatchingEvent));
    }
  }

  return {
    duplicate: false,
    donation: donationFromEvent(storedPrimaryEvent),
    events,
    matchingDonations,
  };
}

async function recordMatchingDonationCommand(client, input) {
  const existingEvent = await findEventByTransactionHash(client, input.transactionHash);
  if (existingEvent) {
    return {
      duplicate: true,
      donation: donationFromEvent(existingEvent),
      event: existingEvent,
    };
  }

  const donationId = input.donationId || uuid();
  const createdAt = input.createdAt || new Date().toISOString();
  const amount = parseAmount(input.amountXLM ?? input.amount);
  const event = createMatchingDonationRecordedEvent(
    {
      ...input,
      eventId: input.eventId,
    },
    donationId,
    createdAt,
    amount,
  );
  const storedEvent = await persistEvent(client, event);

  return {
    duplicate: false,
    donation: donationFromEvent(storedEvent),
    event: storedEvent,
  };
}

module.exports = {
  createDonationRecordedEvent,
  createMatchingDonationRecordedEvent,
  donationFromEvent,
  parseAmount,
  recordDonationCommand,
  recordMatchingDonationCommand,
};
