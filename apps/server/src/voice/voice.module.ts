import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module.js';
import { LiveKitService } from './livekit.service.js';
import { FeaturesController, VoiceController, VoiceWebhookController } from './voice.controller.js';
import { VoiceService } from './voice.service.js';

/** Voice and video channels on a LiveKit media server (off unless LIVEKIT_* is configured). */
@Module({
  imports: [ChatModule],
  controllers: [FeaturesController, VoiceController, VoiceWebhookController],
  providers: [LiveKitService, VoiceService],
  exports: [VoiceService, LiveKitService],
})
export class VoiceModule {}
