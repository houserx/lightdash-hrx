/**
 * Port of the portal's `refs/db-query-portal@aea73de/api/src/services/ask-domain-notes.ts`, verbatim (re-indented).
 */

/** Business context the schema can't convey. Add facts here (one per line) to improve answer accuracy. */
export const DOMAIN_NOTES: readonly string[] = [
    'This is the House Rx pharmacy platform database; most tables describe patients, prescriptions, orders, fills, claims and related workflow, and contain PHI.',
    'Column and table comments (shown by describe_tables) are the authoritative definitions of what a field means; when none exist, say so rather than assuming.',
];
