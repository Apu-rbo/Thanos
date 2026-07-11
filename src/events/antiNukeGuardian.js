import { Events, AuditLogEvent } from 'discord.js';
import { logger } from '../utils/logger.js';
import { registerNukeAction } from '../services/antiNukeService.js';

// Maps Discord audit log action types to our internal action names
const ACTION_MAP = {
    [AuditLogEvent.MemberBanAdd]:  'ban',
    [AuditLogEvent.MemberKick]:    'kick',
    [AuditLogEvent.ChannelDelete]: 'channelDelete',
    [AuditLogEvent.RoleDelete]:    'roleDelete',
    [AuditLogEvent.WebhookCreate]: 'webhookCreate',
};

export default {
    name: Events.GuildAuditLogEntryCreate,
    async execute(auditLogEntry, guild) {
        try {
            const actionType = ACTION_MAP[auditLogEntry.action];
            if (!actionType) return;

            const executorId = auditLogEntry.executorId;
            if (!executorId) return;

            await registerNukeAction(guild.client, guild, executorId, actionType);
        } catch (error) {
            logger.error('[AntiNuke] guildAuditLogEntryCreate handler error:', error);
        }
    },
};
