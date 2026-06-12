import { Events, AuditLogEvent } from 'discord.js';
import { trackAction } from '../utils/antiNuke.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { buildRoleAuditFields } from '../utils/roleLogFields.js';

export default {
  name: Events.GuildRoleDelete,
  once: false,

  async execute(role) {
    try {
      if (!role.guild) return;
      const antiNukeEnabled =
  await role.client.db.get(
    `antinuke:${role.guild.id}`
  );

if (!antiNukeEnabled) {
  return;
}


      const logs = await role.guild.fetchAuditLogs({
  limit: 1,
  type: AuditLogEvent.RoleDelete
});

const entry = logs.entries.first();

if (entry) {
  const count = trackAction(entry.executor.id);

  if (count >= 3) {
    const member = await role.guild.members.fetch(
      entry.executor.id
    );

    await member.roles.set([]);

    logger.warn(
      `ANTI-NUKE: ${entry.executor.tag} mass-deleted roles`
    );

    return;
  }
}

      const fields = buildRoleAuditFields(role, { includeMemberCount: true });

      await logEvent({
        client: role.client,
        guildId: role.guild.id,
        eventType: EVENT_TYPES.ROLE_DELETE,
        data: {
          description: `A role was deleted: ${role.name}`,
          fields
        }
      });

    } catch (error) {
      logger.error('Error in roleDelete event:', error);
    }
  }
};
