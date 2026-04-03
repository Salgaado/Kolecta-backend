export class CreateAuctionDto {
  listingId: string;
  startingBidInCents: number;
  minIncrementInCents?: number;
  reservePriceInCents?: number;
  durationHours?: number;
  antiSniper?: boolean;
}

export class PlaceBidDto {
  amountInCents: number;
}
