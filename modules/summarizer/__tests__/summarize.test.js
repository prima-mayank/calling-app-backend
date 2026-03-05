import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock llmProvider before importing the app
// ---------------------------------------------------------------------------
jest.unstable_mockModule("../llmProvider.js", () => ({
  summarizeText: jest.fn(),
}));

// Dynamic imports after mocking
const { summarizeText } = await import("../llmProvider.js");
const { createApp } = await import("../../../server/createApp.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MOCK_RESULT = {
  summary: "This was a great meeting.",
  bullets: ["Action item one", "Action item two"],
  truncated: false,
};

const makeApp = () => createApp({ authRuntime: null, presenceStore: null });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/summarize", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    summarizeText.mockResolvedValue(MOCK_RESULT);
  });

  it("returns 200 with summary, bullets, truncated on valid input", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: "Hello world this is my meeting transcript." })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("This was a great meeting.");
    expect(res.body.bullets).toEqual(["Action item one", "Action item two"]);
    expect(res.body.truncated).toBe(false);
  });

  it("returns 400 when text field is missing", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({})
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text required");
  });

  it("returns 400 when text is empty string", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: "   " })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text required");
  });

  it("returns 400 when text is not a string", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: 12345 })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text required");
  });

  it("returns 500 when provider throws unexpected error", async () => {
    summarizeText.mockRejectedValue(new Error("unexpected provider failure"));

    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: "Some valid transcript text here." })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("server_error");
  });

  it("returns truncated=true when provider signals truncation", async () => {
    summarizeText.mockResolvedValue({
      summary: "Long meeting summary.",
      bullets: ["Bullet"],
      truncated: true,
    });

    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: "x".repeat(1000) })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
  });

  it("does not leak stack traces in error responses", async () => {
    summarizeText.mockRejectedValue(new Error("internal crash"));

    const app = makeApp();
    const res = await request(app)
      .post("/api/summarize")
      .send({ text: "Some transcript." })
      .set("Content-Type", "application/json");

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("stack");
    expect(JSON.stringify(res.body)).not.toContain("internal crash");
  });
});
