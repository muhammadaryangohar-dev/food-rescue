// OTP rules: separate pickup/delivery codes, expiry at safe-until, lock after
// repeated wrong attempts, idempotent handovers, partial quantities.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resetDb, claimedScenario, acceptedScenario, prisma, user } from './helpers.js';
import { confirmPickup, confirmDelivery, unlockTask, rejectForQuality, getTask } from '../src/modules/rescue/rescue.service.js';
import { deriveOtp } from '../src/lib/otp.js';
import { requestQuantity } from '../src/lib/quantities.js';

beforeAll(resetDb);
afterAll(() => prisma.$disconnect());

const vol = () => user('volunteer@foodrescue.test');
const wrong = (code) => (code === '000000' ? '111111' : '000000');

describe('OTP handover', () => {
  it('full rescue: pickup + delivery codes → DELIVERED, request FULFILLED, only verified food counts', async () => {
    const s = await claimedScenario({ quantity: 20 });
    await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    const { task } = await confirmDelivery(await vol(), s.task.id, { code: s.deliveryCode, quantity: 20 });
    expect(task.status).toBe('DELIVERED');
    expect((await prisma.nGORequest.findUnique({ where: { id: s.request.id } })).status).toBe('FULFILLED');
    const handovers = await prisma.handoverRecord.findMany({ where: { taskId: s.task.id } });
    expect(handovers.map((h) => h.type).sort()).toEqual(['DELIVERY', 'PICKUP']);
  });

  it('pickup code cannot be used for delivery and vice versa', async () => {
    const s = await claimedScenario();
    await expect(confirmPickup(await vol(), s.task.id, { code: s.deliveryCode, quantity: 20 })).rejects.toMatchObject({ code: 'WRONG_CODE' });
    await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    await expect(confirmDelivery(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 })).rejects.toMatchObject({ code: 'WRONG_CODE' });
  });

  it('wrong codes are counted and lock the task after 5; admin unlock restores it', async () => {
    const s = await claimedScenario();
    for (let i = 1; i <= 4; i++) {
      await expect(confirmPickup(await vol(), s.task.id, { code: wrong(s.pickupCode), quantity: 20 })).rejects.toMatchObject({ details: { attemptsLeft: 5 - i } });
    }
    await expect(confirmPickup(await vol(), s.task.id, { code: wrong(s.pickupCode), quantity: 20 })).rejects.toMatchObject({ status: 423 });
    expect((await prisma.rescueTask.findUnique({ where: { id: s.task.id } })).status).toBe('LOCKED');
    // even the right code is refused while locked
    await expect(confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 })).rejects.toMatchObject({ status: 423 });

    const unlocked = await unlockTask(await user('admin@foodrescue.test'), s.task.id);
    expect(unlocked.status).toBe('CLAIMED');
    const { task } = await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    expect(task.status).toBe('PICKED_UP');
  });

  it('codes expire at the food safe-until time', async () => {
    const s = await claimedScenario();
    await prisma.rescueTask.update({ where: { id: s.task.id }, data: { otpExpiresAt: new Date(Date.now() - 1000) } });
    await expect(confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 })).rejects.toMatchObject({ status: 410 });
  });

  it('handover is idempotent (unique per task and type)', async () => {
    const s = await claimedScenario();
    await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    const again = await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    expect(again.alreadyRecorded).toBe(true);
    expect(await prisma.handoverRecord.count({ where: { taskId: s.task.id, type: 'PICKUP' } })).toBe(1);
  });

  it('partial pickup and delivery record the lost quantity; need reopens', async () => {
    const s = await claimedScenario({ quantity: 20 });
    await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 15 });
    await confirmDelivery(await vol(), s.task.id, { code: s.deliveryCode, quantity: 12 });
    const a = await prisma.allocation.findUnique({ where: { id: s.allocation.id } });
    expect(a.lostQuantity).toBe(8);
    const q = await requestQuantity(prisma, { id: s.request.id, requestedQuantity: 20 });
    expect(q.delivered).toBe(12);
    expect(q.remainingNeed).toBe(8);
  });

  it('only the assigned collector can confirm; codes are shown only to donor (pickup) and NGO (delivery)', async () => {
    const s = await claimedScenario();
    await expect(confirmPickup(await user('volunteer2@foodrescue.test'), s.task.id, { code: s.pickupCode, quantity: 20 })).rejects.toMatchObject({ status: 403 });
    const donorView = await getTask(await user('restaurant@foodrescue.test'), s.task.id);
    const ngoView = await getTask(await user('ngo@foodrescue.test'), s.task.id);
    const volView = await getTask(await vol(), s.task.id);
    const adminView = await getTask(await user('admin@foodrescue.test'), s.task.id);
    expect(donorView.codes).toEqual({ pickupCode: s.pickupCode });
    expect(ngoView.codes).toEqual({ deliveryCode: s.deliveryCode });
    expect(volView.codes).toEqual({});
    expect(adminView.codes).toEqual({});
  });

  it('NGO self-collect uses the same codes, NGO is the collector', async () => {
    const s = await acceptedScenario({ selfCollect: true });
    const task = await prisma.rescueTask.findUnique({ where: { id: s.task.id } });
    const ngo = await user('ngo@foodrescue.test');
    await confirmPickup(ngo, task.id, { code: deriveOtp(task.otpNonce, 'PICKUP'), quantity: 20 });
    const { task: done } = await confirmDelivery(ngo, task.id, { code: deriveOtp(task.otpNonce, 'DELIVERY'), quantity: 20 });
    expect(done.status).toBe('DELIVERED');
  });

  it('quality rejection on arrival fails the allocation and loses all of it', async () => {
    const s = await claimedScenario();
    await confirmPickup(await vol(), s.task.id, { code: s.pickupCode, quantity: 20 });
    await rejectForQuality(await user('ngo@foodrescue.test'), s.task.id, { reason: 'Food smelled off' });
    const a = await prisma.allocation.findUnique({ where: { id: s.allocation.id } });
    expect(a.status).toBe('FAILED');
    expect(a.lostQuantity).toBe(20);
  });
});
