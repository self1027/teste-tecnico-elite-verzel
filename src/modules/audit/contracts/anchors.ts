export interface Checkpoint { auctionId: string; sequence: string; hash: string }
export interface ExternalAnchor extends Checkpoint {
  namespace: string;
  previousSequence: string;
  previousHash: string;
  reference: string;
  publishedAt: string;
  signature: string;
}
/** latest must query the independent witness, never audit_anchors or a local cache. */
export interface AnchorVerifier { latest(auctionId: string): Promise<ExternalAnchor | null> }
export interface AnchorPublisher {
  publish(checkpoint: Checkpoint, previous: ExternalAnchor | null): Promise<ExternalAnchor>;
}
