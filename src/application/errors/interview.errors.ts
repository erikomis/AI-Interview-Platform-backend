import { BadRequestException, ConflictException } from '@nestjs/common';

// Typed interview-state errors. They extend the HTTP exceptions REST already
// returned (same status + message), and let the WebSocket layer map each one to
// a stable error code without matching on message text.

export class InterviewNotInProgressException extends BadRequestException {
  constructor() {
    super('Interview is not in progress');
  }
}

export class AllQuestionsAnsweredException extends BadRequestException {
  constructor() {
    super('All questions have been answered — request feedback instead');
  }
}

/** The per-interview lock is held by another answer/feedback request. */
export class InterviewBusyException extends ConflictException {
  constructor(message = 'This interview is busy — try again shortly') {
    super(message);
  }
}
