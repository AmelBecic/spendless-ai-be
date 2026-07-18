import { describe, it, expect } from "vitest";
import { prisma } from "./client";

// Unit test for the singleton — no DB connection (instantiation is lazy).
describe("prisma singleton", () => {
  it("exports one shared PrismaClient instance across imports", async () => {
    const again = (await import("./client")).prisma;
    expect(again).toBe(prisma);
  });

  it("is a PrismaClient (query API present)", () => {
    expect(typeof prisma.$connect).toBe("function");
    expect(typeof prisma.$queryRaw).toBe("function");
  });
});
