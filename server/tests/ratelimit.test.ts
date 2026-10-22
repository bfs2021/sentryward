import cookieParser from "cookie-parser";
import express from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { AUTH_COOKIE, signToken } from "../src/lib/jwt.ts";
import { prisma } from "../src/lib/prisma.ts";
import { userLimitOptions } from "../src/middleware/apiLimiter.ts";
import { createApiToken } from "../src/services/apiTokens.ts";
import { createUser } from "./helpers/users.ts";

// A bare app with only the limiter, so it is tested on its own instead of
// through the API. Users are told apart by a real signed auth cookie.
function limitedApp(limit: number) {
  const app = express();
  app.use(cookieParser());
  app.get("/", rateLimit({ ...userLimitOptions, limit }), (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const as = (userId: string) => `${AUTH_COOKIE}=${signToken(userId)}`;

describe("userLimiter", () => {
  it("answers 429 with a JSON message once a user is over the limit", async () => {
    const app = limitedApp(2);
    await request(app).get("/").set("Cookie", as("u1")).expect(200);
    await request(app).get("/").set("Cookie", as("u1")).expect(200);
    const res = await request(app).get("/").set("Cookie", as("u1")).expect(429);
    expect(res.body).toEqual({ message: "Too many requests, please slow down" });
  });

  it("keeps a separate bucket per user behind one address", async () => {
    const app = limitedApp(1);
    await request(app).get("/").set("Cookie", as("u1")).expect(200);
    await request(app).get("/").set("Cookie", as("u2")).expect(200);
    await request(app).get("/").set("Cookie", as("u1")).expect(429);
  });

  it("limits requests without a valid session by address", async () => {
    const app = limitedApp(1);
    await request(app).get("/").expect(200);
    await request(app).get("/").set("Cookie", `${AUTH_COOKIE}=forged`).expect(429);
    await request(app).get("/").set("Cookie", as("u1")).expect(200);
  });
});

// API tokens are tied to their user by a lookup, so this part needs the database.
describe("userLimiter with API tokens", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("shares one bucket between a user's cookie and tokens", async () => {
    await prisma.workspace.deleteMany();
    await prisma.user.deleteMany();
    const { user, cookie } = await createUser();
    const first = await createApiToken(user.id, "CI", null);
    const second = await createApiToken(user.id, "Script", null);
    const app = limitedApp(2);

    await request(app).get("/").set("Cookie", cookie).expect(200);
    await request(app).get("/").set("Authorization", `Bearer ${first.value}`).expect(200);
    await request(app).get("/").set("Authorization", `Bearer ${second.value}`).expect(429);
  });

  it("limits an unknown token by address", async () => {
    const app = limitedApp(1);
    await request(app).get("/").set("Authorization", "Bearer swt_unknown").expect(200);
    await request(app).get("/").expect(429);
  });
});
