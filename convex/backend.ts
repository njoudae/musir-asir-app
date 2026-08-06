import { v } from "convex/values";
import { env, mutation, query } from "./_generated/server";
import { crossingPointValidator, driverValidator } from "./schema";

const DEFAULT_POINTS = [
  { id: "shaaar", name: "عقبة شعار", route: "أبها / خميس مشيط إلى محايل", lat: 18.4214058, lng: 42.4555221 },
  { id: "aslan", name: "عقبة عسلان", route: "أبها إلى خميس البحر", lat: 18.3909, lng: 42.0572 },
  { id: "dalaa", name: "عقبة ضلع", route: "أبها إلى جازان", lat: 18.1996557, lng: 42.5207894 },
];

type CrossingPoint = (typeof DEFAULT_POINTS)[number];

function configuredPoint(point: CrossingPoint): CrossingPoint {
  return DEFAULT_POINTS.find((candidate) => candidate.id === point.id) ?? point;
}

function authorize(serviceSecret: string) {
  const configuredSecret = env.MUSIR_SERVICE_SECRET;
  if (!configuredSecret || serviceSecret.length < 32 || serviceSecret !== configuredSecret) {
    throw new Error("Unauthorized service request");
  }
}

function publicUser(user: {
  externalId: string;
  phone: string;
  fullName?: string;
  nationalId?: string;
  nationalIdExpiry?: string;
  nafathVerified: boolean;
  profileComplete: boolean;
}) {
  return {
    id: user.externalId,
    phone: user.phone,
    fullName: user.fullName ?? "",
    nationalId: user.nationalId ?? "",
    nationalIdExpiry: user.nationalIdExpiry ?? "",
    nafathVerified: user.nafathVerified,
    profileComplete: user.profileComplete,
  };
}

const TICKET_VALIDITY_MS = 60 * 60 * 1000;

function effectiveExpiry(ticket: { issuedAt: string; expiresAt: string }) {
  const issuedExpiry = Date.parse(ticket.issuedAt) + TICKET_VALIDITY_MS;
  const storedExpiry = Date.parse(ticket.expiresAt);
  const expiry = Number.isFinite(issuedExpiry) && Number.isFinite(storedExpiry)
    ? Math.min(issuedExpiry, storedExpiry)
    : Number.isFinite(issuedExpiry) ? issuedExpiry : storedExpiry;
  return new Date(expiry).toISOString();
}

function statusFor(ticket: { status: "active" | "cancelled"; issuedAt: string; expiresAt: string }, nowMs: number) {
  if (ticket.status === "cancelled") return "cancelled" as const;
  return Date.parse(effectiveExpiry(ticket)) > nowMs ? "active" as const : "expired" as const;
}

export const saveOtpChallenge = mutation({
  args: { serviceSecret: v.string(), phone: v.string(), codeHash: v.string(), expiresAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const existing = await ctx.db.query("otpChallenges").withIndex("by_phone", (q) => q.eq("phone", args.phone)).unique();
    const challenge = { phone: args.phone, codeHash: args.codeHash, expiresAt: args.expiresAt, attempts: 0 };
    if (existing) await ctx.db.replace("otpChallenges", existing._id, challenge);
    else await ctx.db.insert("otpChallenges", challenge);
    return null;
  },
});

export const verifyOtpChallenge = mutation({
  args: { serviceSecret: v.string(), phone: v.string(), codeHash: v.string(), nowMs: v.number() },
  returns: v.union(v.literal("ok"), v.literal("missing"), v.literal("expired"), v.literal("invalid"), v.literal("locked")),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const challenge = await ctx.db.query("otpChallenges").withIndex("by_phone", (q) => q.eq("phone", args.phone)).unique();
    if (!challenge) return "missing";
    if (challenge.expiresAt < args.nowMs) {
      await ctx.db.delete("otpChallenges", challenge._id);
      return "expired";
    }
    const attempts = challenge.attempts + 1;
    if (attempts > 5) {
      await ctx.db.delete("otpChallenges", challenge._id);
      return "locked";
    }
    if (challenge.codeHash !== args.codeHash) {
      await ctx.db.patch("otpChallenges", challenge._id, { attempts });
      return "invalid";
    }
    await ctx.db.delete("otpChallenges", challenge._id);
    return "ok";
  },
});

export const checkRateLimit = mutation({
  args: { serviceSecret: v.string(), key: v.string(), limit: v.number(), windowMs: v.number(), nowMs: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const current = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", args.key)).unique();
    if (!current || current.resetAt < args.nowMs) {
      const next = { key: args.key, count: 1, resetAt: args.nowMs + args.windowMs };
      if (current) await ctx.db.replace("rateLimits", current._id, next);
      else await ctx.db.insert("rateLimits", next);
      return false;
    }
    const count = current.count + 1;
    await ctx.db.patch("rateLimits", current._id, { count });
    return count > args.limit;
  },
});

function publicTicket(ticket: {
  externalId: string;
  ticketNumber: string;
  userExternalId: string;
  driver: { fullName: string; nationalId: string; nationalIdExpiry: string; phone: string };
  truckPlateNumber: string;
  vehicleRegistrationNumber: string;
  vehicleLicenseExpiry: string;
  companyName: string;
  crossingPermitNumber: string;
  companyPermitExpiry: string;
  cargoType: string;
  crossingPoint: { id: string; name: string; route: string; lat: number; lng: number };
  issuedAt: string;
  expiresAt: string;
  status: "active" | "cancelled";
  trackingActive: boolean;
}, nowMs: number) {
  return {
    id: ticket.externalId,
    ticketNumber: ticket.ticketNumber,
    userId: ticket.userExternalId,
    driver: ticket.driver,
    truckPlateNumber: ticket.truckPlateNumber,
    vehicleRegistrationNumber: ticket.vehicleRegistrationNumber,
    vehicleLicenseExpiry: ticket.vehicleLicenseExpiry,
    companyName: ticket.companyName,
    crossingPermitNumber: ticket.crossingPermitNumber,
    companyPermitExpiry: ticket.companyPermitExpiry,
    cargoType: ticket.cargoType,
    crossingPoint: configuredPoint(ticket.crossingPoint),
    issuedAt: ticket.issuedAt,
    expiresAt: effectiveExpiry(ticket),
    status: statusFor(ticket, nowMs),
    trackingActive: ticket.trackingActive,
  };
}

export const seedCrossingPoints = mutation({
  args: { serviceSecret: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    for (const point of DEFAULT_POINTS) {
      const existing = await ctx.db.query("crossingPoints").withIndex("by_external_id", (q) => q.eq("externalId", point.id)).unique();
      const values = { externalId: point.id, name: point.name, route: point.route, lat: point.lat, lng: point.lng };
      if (existing) await ctx.db.replace("crossingPoints", existing._id, values);
      else await ctx.db.insert("crossingPoints", values);
    }
    return null;
  },
});

export const getCrossingPoints = query({
  args: { serviceSecret: v.string() },
  returns: v.array(crossingPointValidator),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const points = await ctx.db.query("crossingPoints").take(100);
    return points.map((point) => configuredPoint({ id: point.externalId, name: point.name, route: point.route, lat: point.lat, lng: point.lng }));
  },
});

export const findOrCreateUser = mutation({
  args: { serviceSecret: v.string(), externalId: v.string(), phone: v.string(), createdAt: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    let user = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", args.phone)).unique();
    if (!user) {
      const id = await ctx.db.insert("users", { externalId: args.externalId, phone: args.phone, nafathVerified: false, profileComplete: false, createdAt: args.createdAt });
      user = await ctx.db.get("users", id);
    }
    if (!user) throw new Error("Unable to create user");
    return publicUser(user);
  },
});

export const getAccount = query({
  args: { serviceSecret: v.string(), externalUserId: v.string(), nowMs: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const user = await ctx.db.query("users").withIndex("by_external_id", (q) => q.eq("externalId", args.externalUserId)).unique();
    if (!user) return null;
    const tickets = await ctx.db.query("tickets").withIndex("by_user_id", (q) => q.eq("userId", user._id)).order("desc").take(200);
    return { user: publicUser(user), tickets: tickets.map((ticket) => publicTicket(ticket, args.nowMs)) };
  },
});

export const updateProfile = mutation({
  args: {
    serviceSecret: v.string(),
    externalUserId: v.string(),
    fullName: v.string(),
    nationalId: v.string(),
    nationalIdExpiry: v.string(),
    profileComplete: v.boolean(),
    updatedAt: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const user = await ctx.db.query("users").withIndex("by_external_id", (q) => q.eq("externalId", args.externalUserId)).unique();
    if (!user) throw new Error("User not found");
    await ctx.db.patch("users", user._id, { fullName: args.fullName, nationalId: args.nationalId, nationalIdExpiry: args.nationalIdExpiry, profileComplete: args.profileComplete, updatedAt: args.updatedAt });
    return publicUser({ ...user, fullName: args.fullName, nationalId: args.nationalId, nationalIdExpiry: args.nationalIdExpiry, profileComplete: args.profileComplete });
  },
});

export const createTicket = mutation({
  args: {
    serviceSecret: v.string(),
    externalId: v.string(),
    externalUserId: v.string(),
    driver: driverValidator,
    truckPlateNumber: v.string(),
    vehicleRegistrationNumber: v.string(),
    vehicleLicenseExpiry: v.string(),
    companyName: v.string(),
    crossingPermitNumber: v.string(),
    companyPermitExpiry: v.string(),
    cargoType: v.string(),
    crossingPoint: crossingPointValidator,
    issuedAt: v.string(),
    expiresAt: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const user = await ctx.db.query("users").withIndex("by_external_id", (q) => q.eq("externalId", args.externalUserId)).unique();
    if (!user) throw new Error("User not found");
    let counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "tickets")).unique();
    const nextValue = (counter?.value ?? 0) + 1;
    if (counter) await ctx.db.patch("counters", counter._id, { value: nextValue });
    else await ctx.db.insert("counters", { name: "tickets", value: nextValue });
    const year = new Date(args.issuedAt).getUTCFullYear();
    const ticketNumber = `MSR-${year}-${String(nextValue).padStart(6, "0")}`;
    const id = await ctx.db.insert("tickets", {
      externalId: args.externalId,
      ticketNumber,
      userId: user._id,
      userExternalId: args.externalUserId,
      driver: args.driver,
      truckPlateNumber: args.truckPlateNumber,
      vehicleRegistrationNumber: args.vehicleRegistrationNumber,
      vehicleLicenseExpiry: args.vehicleLicenseExpiry,
      companyName: args.companyName,
      crossingPermitNumber: args.crossingPermitNumber,
      companyPermitExpiry: args.companyPermitExpiry,
      cargoType: args.cargoType,
      crossingPoint: args.crossingPoint,
      crossingPointExternalId: args.crossingPoint.id,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
      status: "active",
      trackingActive: false,
    });
    const ticket = await ctx.db.get("tickets", id);
    if (!ticket) throw new Error("Unable to create ticket");
    return publicTicket(ticket, Date.parse(args.issuedAt));
  },
});

export const recordLocation = mutation({
  args: { serviceSecret: v.string(), externalUserId: v.string(), ticketExternalId: v.string(), lat: v.number(), lng: v.number(), accuracy: v.number(), recordedAt: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const ticket = await ctx.db.query("tickets").withIndex("by_external_id", (q) => q.eq("externalId", args.ticketExternalId)).unique();
    if (!ticket || ticket.userExternalId !== args.externalUserId) throw new Error("Ticket not found");
    if (!ticket.trackingActive) await ctx.db.patch("tickets", ticket._id, { trackingActive: true });
    const location = { ticketId: ticket._id, ticketExternalId: ticket.externalId, plate: ticket.truckPlateNumber, lat: args.lat, lng: args.lng, accuracy: args.accuracy, recordedAt: args.recordedAt };
    await ctx.db.insert("locations", location);
    const latest = await ctx.db.query("latestLocations").withIndex("by_ticket_id", (q) => q.eq("ticketId", ticket._id)).unique();
    if (latest) await ctx.db.replace("latestLocations", latest._id, location);
    else await ctx.db.insert("latestLocations", location);
    return null;
  },
});

export const setTrackingStatus = mutation({
  args: { serviceSecret: v.string(), externalUserId: v.string(), ticketExternalId: v.string(), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const ticket = await ctx.db.query("tickets").withIndex("by_external_id", (q) => q.eq("externalId", args.ticketExternalId)).unique();
    if (!ticket || ticket.userExternalId !== args.externalUserId) throw new Error("Ticket not found");
    if (ticket.trackingActive !== args.active) await ctx.db.patch("tickets", ticket._id, { trackingActive: args.active });
    return null;
  },
});

export const adminDashboard = query({
  args: { serviceSecret: v.string(), nowMs: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const tickets = await ctx.db.query("tickets").withIndex("by_issued_at").order("desc").take(500);
    const latest = await ctx.db.query("latestLocations").withIndex("by_recorded_at").order("desc").take(1000);
    const latestByTicket = new Map(latest.map((location) => [location.ticketExternalId, { lat: location.lat, lng: location.lng, accuracy: location.accuracy, recordedAt: location.recordedAt }]));
    const vehicles = tickets.map((ticket) => ({ ...publicTicket(ticket, args.nowMs), latestLocation: latestByTicket.get(ticket.externalId) ?? null }));
    const violations = await ctx.db.query("violations").withIndex("by_created_at").order("desc").take(500);
    const crossingEvents = await ctx.db.query("crossingEvents").withIndex("by_created_at").order("desc").take(100);
    const points = await ctx.db.query("crossingPoints").take(100);
    return {
      stats: {
        totalTickets: tickets.length,
        activeTickets: vehicles.filter((ticket) => ticket.status === "active").length,
        trackedTrucks: vehicles.filter((ticket) => ticket.status === "active" && ticket.trackingActive && ticket.latestLocation).length,
        violations: violations.length,
      },
      vehicles,
      violations: violations.map((item) => ({ id: item.externalId, plate: item.plate, crossingPoint: configuredPoint(item.crossingPoint), ticketStatus: item.ticketStatus, ticketNumber: item.ticketNumber, createdAt: item.createdAt, reason: item.reason })),
      crossingEvents: crossingEvents.map((item) => ({ id: item.externalId, plate: item.plate, crossingPoint: configuredPoint(item.crossingPoint), ticketId: item.ticketExternalId, ticketNumber: item.ticketNumber, ticketStatus: item.ticketStatus, createdAt: item.createdAt })),
      points: points.map((point) => configuredPoint({ id: point.externalId, name: point.name, route: point.route, lat: point.lat, lng: point.lng })),
    };
  },
});

export const recordCrossing = mutation({
  args: { serviceSecret: v.string(), externalId: v.string(), violationExternalId: v.string(), plate: v.string(), crossingPointExternalId: v.string(), createdAt: v.string(), nowMs: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    authorize(args.serviceSecret);
    const point = await ctx.db.query("crossingPoints").withIndex("by_external_id", (q) => q.eq("externalId", args.crossingPointExternalId)).unique();
    if (!point) throw new Error("Crossing point not found");
    const crossingPoint = configuredPoint({ id: point.externalId, name: point.name, route: point.route, lat: point.lat, lng: point.lng });
    const ticket = await ctx.db.query("tickets").withIndex("by_plate_and_crossing_point_external_id", (q) => q.eq("truckPlateNumber", args.plate).eq("crossingPointExternalId", args.crossingPointExternalId)).order("desc").first();
    const ticketStatus = ticket ? statusFor(ticket, args.nowMs) : "none" as const;
    const event = {
      externalId: args.externalId,
      plate: args.plate,
      crossingPoint,
      ticketExternalId: ticket?.externalId ?? null,
      ticketNumber: ticket?.ticketNumber ?? null,
      ticketStatus,
      createdAt: args.createdAt,
    };
    await ctx.db.insert("crossingEvents", event);
    if (ticketStatus !== "active") {
      await ctx.db.insert("violations", {
        externalId: args.violationExternalId,
        plate: args.plate,
        crossingPoint,
        ticketStatus: ticketStatus === "cancelled" ? "none" : ticketStatus,
        ticketNumber: ticket?.ticketNumber ?? null,
        createdAt: args.createdAt,
        reason: ticketStatus === "expired" ? "عبور بتذكرة منتهية" : "عبور دون تذكرة",
      });
    }
    return { event: { id: event.externalId, plate: event.plate, crossingPoint: event.crossingPoint, ticketId: event.ticketExternalId, ticketNumber: event.ticketNumber, ticketStatus: event.ticketStatus, createdAt: event.createdAt }, violationRecorded: ticketStatus !== "active" };
  },
});
