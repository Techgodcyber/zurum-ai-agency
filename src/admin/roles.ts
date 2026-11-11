/**
 * Role-based access control for the admin control centre.
 *
 * Roles map to a fixed set of capabilities. Everything the UI and the request
 * handlers do is gated on a capability (never on a role name directly), so adding
 * a new role later is a one-line change here — nothing else moves.
 */

export const ROLES = [
  "owner",
  "manager",
  "support",
  "marketer",
  "developer",
  "spectator",
] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "sites.view",
  "sites.suspend", // kill switch
  "customers.view",
  "customers.credits", // grant/adjust credits
  "customers.limits", // change per-customer free limits
  "jobs.view",
  "submissions.view", // website enquiries
  "revenue.view",
  "settings.view",
  "settings.edit", // pricing + limits
  "staff.view",
  "staff.manage", // create/deactivate staff, assign roles
  "audit.view",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const VIEW_ONLY: Capability[] = [
  "sites.view",
  "customers.view",
  "jobs.view",
  "submissions.view",
  "revenue.view",
  "settings.view",
];

const MATRIX: Record<Role, Capability[]> = {
  // Full control, including staff.
  owner: [...CAPABILITIES],
  // Runs the business day to day; cannot manage staff accounts.
  manager: [
    ...VIEW_ONLY,
    "sites.suspend",
    "customers.credits",
    "customers.limits",
    "settings.edit",
    "staff.view",
    "audit.view",
  ],
  // Helps customers: can refund/grant credits and take down a bad site.
  support: [
    "sites.view",
    "sites.suspend",
    "customers.view",
    "customers.credits",
    "jobs.view",
    "submissions.view",
  ],
  // Growth: sees customers and sites, no money or destructive powers.
  marketer: ["sites.view", "customers.view", "submissions.view", "revenue.view"],
  // Technical: diagnoses builds; no customer money powers.
  developer: ["sites.view", "jobs.view", "submissions.view", "settings.view", "audit.view"],
  // Read-only observer.
  spectator: VIEW_ONLY,
};

export function capabilitiesFor(role: Role): Capability[] {
  return MATRIX[role] ?? [];
}

export function can(role: Role, cap: Capability): boolean {
  return capabilitiesFor(role).includes(cap);
}

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

/** One-line description shown in the staff UI. */
export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: "Full control, including staff and settings",
  manager: "Runs operations: sites, customers, credits, settings",
  support: "Helps customers: credits, enquiries, site takedown",
  marketer: "Growth: customers, sites and enquiries (read-only)",
  developer: "Technical: builds, jobs, settings and audit (read-only)",
  spectator: "Read-only view of everything operational",
};
