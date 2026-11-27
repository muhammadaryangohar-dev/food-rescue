// CP4: "race conditions between simultaneous NGOs and volunteers".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { resetDb, acceptedScenario, prisma, user } from './helpers.js';
import { claimTask, unclaimTask } from '../src/modules/rescue/rescue.service.js';

beforeAll(async () => {
  await resetDb();
  const passwordHash = await bcrypt.hash('Password123', 4);
  for (let i = 1; i <= 6; i++) {
    await prisma.user.create({
      data: { email: `racer${i}@test.local`, name: `Racer ${i}`, role: 'VOLUNTEER', passwordHash, volunteerProfile: { create: { approvalStatus: 'VERIFIED' } } },
    });
  }
});
afterAll(() => prisma.$disconnect());

describe('volunteer claim race', () => {
  it('6 volunteers claim the same task at once: exactly one wins', async () => {
    const { task } = await acceptedScenario();
    const racers = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => user(`racer${i}@test.local`)));
    const results = await Promise.allSettled(racers.map((v) => claimTask(v, task.id)));

    const winners = results.filter((r) => r.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 409)).toBe(true);

    const fresh = await prisma.rescueTask.findUnique({ where: { id: task.id } });
    expect(fresh.status).toBe('CLAIMED');
    expect(fresh.volunteerId).toBe(winners[0].value.volunteer.id);
  });

  it('unverified volunteers cannot claim; released tasks can be claimed again', async () => {
    const { task } = await acceptedScenario();
    await expect(claimTask(await user('volunteer-pending@foodrescue.test'), task.id)).rejects.toThrow(/approval/);

    const v1 = await user('racer1@test.local');
    await claimTask(v1, task.id);
    await unclaimTask(v1, task.id);
    const v2 = await user('racer2@test.local');
    const claimed = await claimTask(v2, task.id);
    expect(claimed.status).toBe('CLAIMED');
  });

  it('volunteers with too many no-shows are blocked', async () => {
    const { task } = await acceptedScenario();
    const v = await user('racer3@test.local');
    await prisma.volunteerProfile.update({ where: { id: v.volunteerProfile.id }, data: { noShowCount: 3 } });
    await expect(claimTask(await user('racer3@test.local'), task.id)).rejects.toThrow(/no-shows/);
  });

  it('self-collect tasks cannot be claimed by volunteers', async () => {
    const { task } = await acceptedScenario({ selfCollect: true });
    await expect(claimTask(await user('racer4@test.local'), task.id)).rejects.toThrow(/NGO is collecting/);
  });
});
