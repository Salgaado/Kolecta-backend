# Graph Report - kolecta-backend  (2026-07-24)

## Corpus Check
- 183 files · ~123,084 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1252 nodes · 2134 edges · 76 communities (50 shown, 26 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b4956edf`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]

## God Nodes (most connected - your core abstractions)
1. `FounderService` - 32 edges
2. `CommunityService` - 31 edges
3. `AuctionsService` - 28 edges
4. `AuthGuard` - 28 edges
5. `ListingsService` - 26 edges
6. `OrdersService` - 26 edges
7. `AdminService` - 24 edges
8. `WalletService` - 23 edges
9. `compilerOptions` - 22 edges
10. `RolesGuard` - 21 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `buildRecipientPayload()`  [EXTRACTED]
  scripts/test-recipient-sandbox.ts → src/recipients/recipient-payload.ts
- `html()` --calls--> `renderLayout()`  [EXTRACTED]
  src/notifications/templates/kyc-action-needed.ts → src/notifications/templates/layout.ts
- `html()` --calls--> `renderLayout()`  [EXTRACTED]
  src/notifications/templates/kyc-approved.ts → src/notifications/templates/layout.ts
- `html()` --calls--> `formatBRL()`  [EXTRACTED]
  src/notifications/templates/order-confirmed.ts → src/notifications/templates/layout.ts
- `html()` --calls--> `formatBRL()`  [EXTRACTED]
  src/notifications/templates/sale-made.ts → src/notifications/templates/layout.ts

## Communities (76 total, 26 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.05
Nodes (33): AddressesModule, AdminModule, AuctionsModule, AuthModule, DevAuthMiddleware, BlingController, BlingModule, BlingService (+25 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (24): KycActionNeededEvent, KycApprovedEvent, KycListener, OrderListener, OrderPaidEvent, MailService, msg(), SendOptions (+16 more)

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (18): CreateOrderDto, OrderItemDto, UpdateOrderStatusDto, CreateDepositDto, em12, em2, { options }, { OrdersService } (+10 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (12): ConnectController, ConnectAccountsModule, ConnectService, Database, StripeConfigService, StripeCoreModule, StripeService, RawRequest (+4 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (11): CommunityRankingCron, CommunityService, computePostScore(), base, db, fresh, now, old (+3 more)

### Community 6 - "Community 6"
Cohesion: 0.10
Nodes (21): AddressDto, BankAccountDto, CreateRecipientDto, ManagingPartnerDto, isValidCnpj(), isValidCpf(), isValidDocument(), buildRecipientPayload() (+13 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (15): DepositsService, PagarmeCharge, PagarmeOrderResponse, PagarmeTransaction, RecordConsentDto, UpdateUserDto, UsersController, fakeUser (+7 more)

### Community 9 - "Community 9"
Cohesion: 0.11
Nodes (11): GenerateLabelDto, QuoteShippingDto, VolumesDto, ShippingController, ShippingModule, ShippingService, dto, fromAddress (+3 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (9): AuctionsService, AUTH_VALIDITY_DAYS, PAYMENT_DEADLINE_HOURS, REAUTH_WINDOW_HOURS, CloseAuctionsCron, CreateAuctionDto, PlaceBidDto, buildSplit() (+1 more)

### Community 11 - "Community 11"
Cohesion: 0.07
Nodes (27): devDependencies, drizzle-kit, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.08
Nodes (24): addresses, auctions, bids, blingConnections, communityBans, communityComments, communityPins, communityPostLikes (+16 more)

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (20): authorizedOrder, endedAuction, expiredAuction, expiredAuction1, expiredAuction2, mockAuction, mockBid, mockCardsService (+12 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (7): AddressesController, AddressesService, dto, mockAddress, updated, CreateAddressDto, UpdateAddressDto

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (22): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+14 more)

### Community 16 - "Community 16"
Cohesion: 0.09
Nodes (23): dependencies, @aws-sdk/client-s3, axios, class-transformer, class-validator, @clerk/clerk-sdk-node, @clerk/express, dotenv (+15 more)

### Community 17 - "Community 17"
Cohesion: 0.13
Nodes (11): mockWebhookService, WebhookController, WebhookModule, mockDb, mockDelete, mockInsert, mockUpdate, userCreatedEvt (+3 more)

### Community 18 - "Community 18"
Cohesion: 0.12
Nodes (7): CommunityController, userId(), APPLY, ClerkUser, db, fetchClerkUsers(), main()

### Community 19 - "Community 19"
Cohesion: 0.05
Nodes (33): AuthGuard, Roles(), RolesGuard, FeedSort, DepositsController, BanUserDto, CreateCommentDto, CreatePostDto (+25 more)

### Community 20 - "Community 20"
Cohesion: 0.13
Nodes (6): FavoritesController, FavoritesModule, FavoritesService, mockDb, mockFavorite, mockListing

### Community 22 - "Community 22"
Cohesion: 0.13
Nodes (9): RequestWithdrawalDto, PagarmeTransfer, mockPagarme, mockSellerProfile, mockWallet, mockWalletService, mockWithdrawal, WITHDRAWAL_MIN_CENTS (+1 more)

### Community 24 - "Community 24"
Cohesion: 0.16
Nodes (3): CardsController, CardsService, SaveCardDto

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (7): MessagesService, fakeConversation, fakeMessage, insertChain, mockDb, queryMock, updateChain

### Community 26 - "Community 26"
Cohesion: 0.10
Nodes (6): Database, ReleaseBalanceCron, Database, mockDb, mockTx, WalletService

### Community 29 - "Community 29"
Cohesion: 0.15
Nodes (7): CreateReviewDto, REVIEWABLE_STATUSES, ReviewsService, baseOrder, db, insertedReview, service

### Community 30 - "Community 30"
Cohesion: 0.13
Nodes (12): closedDispute, mockDispute, mockListing, mockSellerProfile, mockUser, profileVerified, resolvedDispute, updatedDispute (+4 more)

### Community 31 - "Community 31"
Cohesion: 0.13
Nodes (9): AuthGuardAllow, AuthGuardDeny, mockAdminService, mockDispute, mockSellerProfile, mockStats, mockUser, RolesGuardAllow (+1 more)

### Community 32 - "Community 32"
Cohesion: 0.14
Nodes (13): code:bash ($ npm install), code:bash (# development), code:bash (# unit tests), code:bash ($ npm install -g @nestjs/mau), Compile and run the project, Deployment, Description, License (+5 more)

### Community 33 - "Community 33"
Cohesion: 0.15
Nodes (13): scripts, build, format, lint, start, start:debug, start:dev, start:prod (+5 more)

### Community 34 - "Community 34"
Cohesion: 0.21
Nodes (3): PagarmeConfigService, Database, PagarmeWebhookEvent

### Community 35 - "Community 35"
Cohesion: 0.15
Nodes (12): baseDto, fakeListingActive, fakeListingOwn, fakeListingSold, insertChain, mockDb, mockPagarmeService, mockTx (+4 more)

### Community 36 - "Community 36"
Cohesion: 0.13
Nodes (18): CATEGORY_REQUIRED_FIELDS, COLUMN_KEYS, countImages(), hasFieldValue(), listingPublishBlockers(), ListingPublishContext, ListingPublishFields, parseAttributes() (+10 more)

### Community 38 - "Community 38"
Cohesion: 0.50
Nodes (3): MaskedCard, PagarmeCard, PagarmeCustomer

### Community 39 - "Community 39"
Cohesion: 0.17
Nodes (7): CategoriesController, CategoriesModule, CategoriesService, db, mockCategories, service, categories

### Community 41 - "Community 41"
Cohesion: 0.14
Nodes (13): auctionListing, deleteChain, dto, fakeListing, incompleto, insertChain, insertedTables, mockDb (+5 more)

### Community 43 - "Community 43"
Cohesion: 0.22
Nodes (9): jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, testEnvironment, testRegex, transform (+1 more)

### Community 44 - "Community 44"
Cohesion: 0.31
Nodes (7): CreateListingDto, UpdateListingDto, INVITE_RANGE, LANDING_RANGE, SUBMITTED_LISTING_STATUSES, SellerProfile, ListingRecord

### Community 45 - "Community 45"
Cohesion: 0.28
Nodes (7): disputeMessages, disputes, listings, orders, reviews, sellerProfiles, users

### Community 46 - "Community 46"
Cohesion: 0.31
Nodes (8): APPLY, countRefs(), DEAD_PLACEHOLDERS, discoverUserRefs(), hasEmptyWallet(), main(), REASSIGN_LISTINGS_FROM, UserRef

### Community 48 - "Community 48"
Cohesion: 0.50
Nodes (7): ClerkUser, db, fetchClerkUsers(), list(), main(), promote(), tursoRole()

### Community 53 - "Community 53"
Cohesion: 0.29
Nodes (6): author, description, license, name, private, version

### Community 54 - "Community 54"
Cohesion: 0.29
Nodes (6): moduleFileExtensions, rootDir, testEnvironment, testRegex, transform, ^.+\\.(t|j)s$

### Community 55 - "Community 55"
Cohesion: 0.22
Nodes (3): RedeemInviteDto, UseCreditDto, FounderController

### Community 56 - "Community 56"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 59 - "Community 59"
Cohesion: 0.33
Nodes (4): CANONICAL, canonicalIds, client, db

### Community 60 - "Community 60"
Cohesion: 0.33
Nodes (4): client, db, devUsers, mockCategories

### Community 61 - "Community 61"
Cohesion: 0.33
Nodes (5): APPLY, client, ids, placeholders, rows

### Community 64 - "Community 64"
Cohesion: 0.50
Nodes (4): client, db, listUsers(), main()

### Community 65 - "Community 65"
Cohesion: 0.50
Nodes (4): codeFor(), db, DRY, main()

## Knowledge Gaps
- **368 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+363 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **26 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `CommunityService` connect `Community 5` to `Community 0`, `Community 19`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Why does `AuctionsService` connect `Community 10` to `Community 0`, `Community 19`, `Community 13`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **Why does `ListingsService` connect `Community 7` to `Community 0`, `Community 71`, `Community 41`, `Community 44`, `Community 18`, `Community 19`, `Community 30`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _368 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.05446727185857621 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.0730804810360777 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.06342494714587738 - nodes in this community are weakly interconnected._