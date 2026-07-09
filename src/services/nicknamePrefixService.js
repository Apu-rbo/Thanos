import { logger } from '../utils/logger.js';
import { getConfigValue, setConfigValue } from './guildConfig.js';

const CONFIG_KEY = 'nicknamePrefixes';

const DEFAULT_STATE = {
    enabled: false,
    rolePrefixes: {},   // { roleId: "[VIP]" }
    manualPrefixes: {}, // { userId: "[Owner]" }
};

// ── Config helpers ────────────────────────────────────────────────────────────

export async function getPrefixConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULT_STATE, ...(stored ?? {}) };
}

export async function savePrefixConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

// ── Prefix resolution ─────────────────────────────────────────────────────────

/**
 * Determine what prefix (if any) a member should have right now,
 * based on manual override first, then highest-position mapped role.
 */
export function resolvePrefixForMember(member, config) {
    // Manual override always wins
    const manual = config.manualPrefixes[member.id];
    if (manual) return manual;

    if (!config.enabled) return null;

    // Find all roles the member has that are mapped to a prefix
    const mappedRoleIds = Object.keys(config.rolePrefixes);
    if (mappedRoleIds.length === 0) return null;

    const matchingRoles = member.roles.cache.filter(r => mappedRoleIds.includes(r.id));
    if (matchingRoles.size === 0) return null;

    // Pick the highest-position role (most "senior")
    const topRole = matchingRoles.sort((a, b) => b.position - a.position).first();
    return config.rolePrefixes[topRole.id];
}

/**
 * Strip any known prefix (role-based or manual) from the start of a name.
 */
function stripKnownPrefixes(name, config) {
    if (!name) return name;
    const allPrefixes = [
        ...Object.values(config.rolePrefixes),
        ...Object.values(config.manualPrefixes),
    ];

    let result = name;
    for (const prefix of allPrefixes) {
        if (result.startsWith(prefix)) {
            result = result.slice(prefix.length).trim();
            break;
        }
    }
    return result;
}

/**
 * Apply (or remove) the correct nickname prefix for a member.
 * Safe to call any time — computes the right state and only edits if needed.
 */
export async function syncMemberNickname(client, member, config) {
    try {
        // Can't touch the server owner or members with a higher/equal top role than the bot
        if (member.id === member.guild.ownerId) return { success: false, reason: 'Cannot modify server owner nickname.' };

        const botMember = member.guild.members.me;
        if (member.roles.highest.position >= botMember.roles.highest.position) {
            return { success: false, reason: 'Member role is higher than or equal to bot role.' };
        }

        const currentName = member.nickname ?? member.user.username;
        const baseName     = stripKnownPrefixes(currentName, config);
        const targetPrefix = resolvePrefixForMember(member, config);

        const desiredNick = targetPrefix ? `${targetPrefix} ${baseName}`.trim() : baseName;
        const finalNick   = desiredNick.slice(0, 32); // Discord nickname limit

        // Only current nickname (or username fallback) needs updating if different
        const effectiveCurrent = member.nickname ?? member.user.username;
        if (finalNick === effectiveCurrent) return { success: true, unchanged: true };

        // If final equals username exactly and member has no custom nickname otherwise, clear nickname instead
        if (finalNick === member.user.username) {
            await member.setNickname(null, '[NickPrefix] Auto sync').catch(() => null);
        } else {
            await member.setNickname(finalNick, '[NickPrefix] Auto sync');
        }

        return { success: true, newNick: finalNick };
    } catch (err) {
        logger.warn(`[NickPrefix] Failed to update nickname for ${member.id}: ${err.message}`);
        return { success: false, reason: err.message };
    }
}

/**
 * Re-sync every member in the guild (used after config changes).
 */
export async function syncAllMembers(client, guild, config) {
    let updated = 0, failed = 0, skipped = 0;

    const members = await guild.members.fetch();
    for (const [, member] of members) {
        if (member.user.bot) continue;
        const result = await syncMemberNickname(client, member, config);
        if (result.success && !result.unchanged) updated++;
        else if (result.success && result.unchanged) skipped++;
        else failed++;
    }

    return { updated, failed, skipped };
}
