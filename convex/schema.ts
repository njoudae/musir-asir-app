import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const crossingPointValidator = v.object({
  id: v.string(),
  name: v.string(),
  route: v.string(),
  lat: v.number(),
  lng: v.number(),
});

export const driverValidator = v.object({
  fullName: v.string(),
  nationalId: v.string(),
  nationalIdExpiry: v.string(),
  phone: v.string(),
});

export default defineSchema({
  otpChallenges: defineTable({
    phone: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
  }).index("by_phone", ["phone"]),

  rateLimits: defineTable({
    key: v.string(),
    count: v.number(),
    resetAt: v.number(),
  }).index("by_key", ["key"]),

  users: defineTable({
    externalId: v.string(),
    phone: v.string(),
    fullName: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    nationalIdExpiry: v.optional(v.string()),
    nafathVerified: v.boolean(),
    profileComplete: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  })
    .index("by_external_id", ["externalId"])
    .index("by_phone", ["phone"]),

  crossingPoints: defineTable({
    externalId: v.string(),
    name: v.string(),
    route: v.string(),
    lat: v.number(),
    lng: v.number(),
  }).index("by_external_id", ["externalId"]),

  tickets: defineTable({
    externalId: v.string(),
    ticketNumber: v.string(),
    userId: v.id("users"),
    userExternalId: v.string(),
    driver: driverValidator,
    truckPlateNumber: v.string(),
    vehicleRegistrationNumber: v.string(),
    vehicleLicenseExpiry: v.string(),
    companyName: v.string(),
    crossingPermitNumber: v.string(),
    companyPermitExpiry: v.string(),
    cargoType: v.string(),
    crossingPoint: crossingPointValidator,
    crossingPointExternalId: v.string(),
    issuedAt: v.string(),
    expiresAt: v.string(),
    status: v.union(v.literal("active"), v.literal("cancelled")),
    trackingActive: v.boolean(),
  })
    .index("by_external_id", ["externalId"])
    .index("by_user_id", ["userId"])
    .index("by_issued_at", ["issuedAt"])
    .index("by_plate_and_crossing_point_external_id", ["truckPlateNumber", "crossingPointExternalId"]),

  locations: defineTable({
    ticketId: v.id("tickets"),
    ticketExternalId: v.string(),
    plate: v.string(),
    lat: v.number(),
    lng: v.number(),
    accuracy: v.number(),
    recordedAt: v.string(),
  })
    .index("by_ticket_id", ["ticketId"])
    .index("by_recorded_at", ["recordedAt"]),

  latestLocations: defineTable({
    ticketId: v.id("tickets"),
    ticketExternalId: v.string(),
    plate: v.string(),
    lat: v.number(),
    lng: v.number(),
    accuracy: v.number(),
    recordedAt: v.string(),
  })
    .index("by_ticket_id", ["ticketId"])
    .index("by_recorded_at", ["recordedAt"]),

  violations: defineTable({
    externalId: v.string(),
    plate: v.string(),
    crossingPoint: crossingPointValidator,
    ticketStatus: v.union(v.literal("expired"), v.literal("none")),
    ticketNumber: v.union(v.string(), v.null()),
    createdAt: v.string(),
    reason: v.string(),
  }).index("by_created_at", ["createdAt"]),

  crossingEvents: defineTable({
    externalId: v.string(),
    plate: v.string(),
    crossingPoint: crossingPointValidator,
    ticketExternalId: v.union(v.string(), v.null()),
    ticketNumber: v.union(v.string(), v.null()),
    ticketStatus: v.union(v.literal("active"), v.literal("expired"), v.literal("none"), v.literal("cancelled")),
    createdAt: v.string(),
  }).index("by_created_at", ["createdAt"]),

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),
});
