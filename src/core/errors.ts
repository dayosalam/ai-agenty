export class PeermateError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** Thrown when code attempts to send into a group. Peermate is a reader; see PRD §7. */
export class GroupSendForbidden extends PeermateError {}

export class TranscriptionFailed extends PeermateError {}

/** Retrieval could not run — the question is fine, the search is not. */
export class RetrievalUnavailable extends PeermateError {}

/** The student asked for something Peermate does not do. */
export class Unsupported extends PeermateError {}
export class ExtractionFailed extends PeermateError {}
