# ER diagram

The source of truth is `backend/prisma/schema.prisma`. The diagram below is written in Mermaid, which GitHub renders automatically.

```mermaid
erDiagram
    Organisation ||--o{ User : "staff"
    User ||--o| VolunteerProfile : "volunteer"

    Organisation ||--o{ FoodItem : "menu items"
    FoodCategory ||--o{ FoodItem : ""
    FoodItem ||--o{ DailyFoodRecord : "one per day"
    Organisation ||--o{ Event : "organises"
    Event ||--o{ EventFoodPlan : ""
    FoodItem ||--o{ EventFoodPlan : ""

    Organisation |o--o{ SurplusListing : "restaurant source"
    Event |o--o{ SurplusListing : "event source"
    FoodCategory ||--o{ SurplusListing : ""

    Organisation ||--o{ NGORequest : "NGO asks"
    FoodCategory ||--o{ NGORequest : ""

    SurplusListing ||--o{ Allocation : "food from"
    NGORequest ||--o{ Allocation : "food for"
    SurplusListing ||--o{ MatchDecision : ""
    NGORequest ||--o{ MatchDecision : ""

    Allocation ||--o| RescueTask : "on acceptance"
    VolunteerProfile |o--o{ RescueTask : "claims"
    RescueTask ||--o{ HandoverRecord : "pickup + delivery"
    User ||--o{ HandoverRecord : "recorded by"

    Allocation ||--o{ Report : ""
    User ||--o{ Report : "files / resolves"
    User ||--o{ Notification : ""
    User |o--o{ StatusHistory : "actor (null = system)"
    User |o--o{ SystemConfig : "last updated by"

    SurplusListing {
        int id PK
        enum source_type "RESTAURANT | EVENT"
        int organisation_id FK "always set: the donor business"
        int event_id FK "set only when source_type = EVENT"
        int confirmed_quantity "ONLY stored quantity, > 0"
        datetime safe_until
        datetime collection_deadline "<= safe_until"
        enum status "OPEN | CLOSED | EXPIRED"
    }
    NGORequest {
        int id PK
        int ngo_id FK
        int requested_quantity "> 0"
        datetime required_by
        enum status "OPEN | FULFILLED | CANCELLED | EXPIRED"
        bool reallocation_pending
    }
    Allocation {
        int id PK
        int listing_id FK
        int request_id FK
        int quantity "> 0"
        int lost_quantity "0..quantity"
        enum status
        float score
        json score_breakdown
        datetime response_deadline
        datetime pickup_deadline
    }
    RescueTask {
        int id PK
        int allocation_id FK "unique"
        enum collector_type "VOLUNTEER | NGO"
        int volunteer_id FK
        string pickup_otp_hash
        string delivery_otp_hash
        int failed_attempts
        datetime otp_expires_at
        enum status
    }
    HandoverRecord {
        int id PK
        int task_id FK "unique with type"
        enum type "PICKUP | DELIVERY"
        int quantity
    }
```

## Constraints

Most of these are written by hand at the end of the migration files (`prisma/migrations/*/migration.sql`). The unique constraints come from `schema.prisma`.

| Constraint | Rule |
|---|---|
| `chk_listing_source` | `organisation_id` is always set (NOT NULL); `event_id` is set exactly when `source_type` is EVENT |
| `chk_org_ngo_fields` | an NGO must have `ngo_type`; donor businesses cannot have `ngo_type`, `beneficiaries` or `show_in_directory` |
| `chk_donor_org_licence` | a donor business (restaurant, marquee / caterer) must have a licence number and authority; NGOs need none |
| `chk_listing_deadline` | `collection_deadline <= safe_until` |
| `chk_*_qty_positive` / `chk_*_nonneg` | quantities, capacities and attempts are never negative |
| `chk_alloc_lost_range` | `0 <= lost_quantity <= quantity` |
| `chk_task_claimed_has_volunteer` | a claimed or picked-up volunteer task names its volunteer |
| unique | `users.email`; `organisations(licence_authority, licence_number)`; `handover_records(task_id, type)`; `rescue_tasks.allocation_id`; `daily_food_records(food_item_id, date)` |
| indexes | status plus deadline columns on listings, requests, allocations and tasks, which the sweep's cheap check uses |

## Derived quantities

These are never stored. They are calculated in `src/lib/quantities.js`.

- **Listing committed** = sum of `quantity` over its allocations in PROPOSED, ACCEPTED, PICKED_UP, DELIVERED or FAILED.
- **Listing remaining** = `confirmed_quantity` minus committed. A REJECTED, EXPIRED or CANCELLED allocation stops counting, so its food is released automatically.
- **Request covered** = sum of `quantity - lost_quantity` over its allocations in PROPOSED, ACCEPTED, PICKED_UP or DELIVERED. FAILED does not count, so the need opens again.
- **Delivered (Rescued)** = sum of `quantity - lost_quantity` over DELIVERED allocations.
