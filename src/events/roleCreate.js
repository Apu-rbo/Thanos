import { Events, AuditLogEvent } from 'discord.js';
import { trackAction } from '../utils/antiNuke.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { logger } from '../utils/logger.js';
import { buildRoleAuditFields } from '../utils/roleLogFields.js';

export default {
  name: Events.GuildRoleCreate,
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
  type: AuditLogEvent.RoleCreate
});

const entry = logs.entries.first();

if (entry) {
  const count = trackAction(entry.executor.id);

  if (count >= 5) {
    const member = await role.guild.members.fetch(
      entry.executor.id
    );

    await member.roles.set([]);

    logger.warn(
      `ANTI-NUKE: ${entry.executor.tag} mass-created roles`
    );

    return;
  }
}

      const fields = buildRoleAuditFields(role);

      await logEvent({
        client: role.client,
        guildId: role.guild.id,
        eventType: EVENT_TYPES.ROLE_CREATE,
        data: {
          description: `A new role was created: ${role.toString()}`,
          fields
        }
      });

    } catch (error) {
      logger.error('Error in roleCreate event:', error);
    }
  }
};
