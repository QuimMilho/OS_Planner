import { Injectable } from '@nestjs/common';
import { newId } from '../common/crypto.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

type Db = PrismaService | Tx;

@Injectable()
export class SpacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every account has exactly one personal space; created together with the account. */
  async createPersonal(tx: Tx, userId: string): Promise<string> {
    const id = newId();
    await tx.space.create({ data: { id, kind: 'personal', userId } });
    return id;
  }

  async personalSpaceId(userId: string, db: Db = this.prisma): Promise<string> {
    const space = await db.space.findUnique({ where: { userId }, select: { id: true } });
    // Every account gets one when it is created (and the migration made one for older accounts).
    if (!space) throw new Error(`user ${userId} has no personal space`);
    return space.id;
  }
}
