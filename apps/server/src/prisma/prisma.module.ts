import { Global, Module } from '@nestjs/common';
import { ChangeSeqService } from './change-seq.service.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  providers: [PrismaService, ChangeSeqService],
  exports: [PrismaService, ChangeSeqService],
})
export class PrismaModule {}
