# State machines

Every transition writes a `status_history` row. `actor_user_id` is null when the system made the change (the sweep).

## Allocation

```mermaid
stateDiagram-v2
    [*] --> PROPOSED : matching engine / admin<br/>(locked, all rules re-checked)
    PROPOSED --> ACCEPTED : NGO accepts<br/>(re-check: food still open and safe)
    PROPOSED --> REJECTED : NGO rejects (reason)
    PROPOSED --> EXPIRED : no answer by response_deadline (sweep)
    PROPOSED --> CANCELLED : listing withdrawn / request cancelled / NGO or admin cancels
    ACCEPTED --> PICKED_UP : pickup code verified
    ACCEPTED --> EXPIRED : not collected by pickup_deadline (sweep)
    ACCEPTED --> CANCELLED : listing withdrawn / NGO or admin cancels
    PICKED_UP --> DELIVERED : delivery code verified
    PICKED_UP --> FAILED : past safe_until (sweep) / NGO rejects for quality
    DELIVERED --> FAILED : upheld report reverses delivery
    REJECTED --> [*]
    EXPIRED --> [*]
    CANCELLED --> [*]
    DELIVERED --> [*]
    FAILED --> [*]
```

REJECTED, EXPIRED and CANCELLED **release** their food, because it stops counting in the derived quantities. The request is flagged `reallocation_pending`, and the next matching run offers the food again.

## Rescue task

```mermaid
stateDiagram-v2
    [*] --> OPEN : offer accepted (volunteer collects)
    [*] --> CLAIMED : offer accepted with selfCollect (NGO collects)
    OPEN --> CLAIMED : volunteer claims (race-safe, one winner)
    CLAIMED --> OPEN : volunteer unclaims / claim_deadline passed (sweep, +1 no-show)
    CLAIMED --> PICKED_UP : pickup code verified
    PICKED_UP --> DELIVERED : delivery code verified
    CLAIMED --> LOCKED : 5 wrong codes
    PICKED_UP --> LOCKED : 5 wrong codes
    LOCKED --> CLAIMED : admin unlock (before pickup)
    LOCKED --> PICKED_UP : admin unlock (after pickup)
    OPEN --> CANCELLED : allocation cancelled / expired
    CLAIMED --> CANCELLED : allocation cancelled / expired
    PICKED_UP --> CANCELLED : late delivery / quality rejection
```

## Listing, request, report

```mermaid
stateDiagram-v2
    state "Listing" as L {
        [*] --> L_OPEN
        L_OPEN --> L_CLOSED : donor withdraws / all food handled
        L_OPEN --> L_EXPIRED : collection_deadline passed (sweep)
    }
    state "Request" as R {
        [*] --> R_OPEN
        R_OPEN --> R_FULFILLED : delivered >= requested
        R_OPEN --> R_CANCELLED : NGO cancels
        R_OPEN --> R_EXPIRED : required_by passed (sweep)
        R_FULFILLED --> R_OPEN : upheld report reverses a delivery
    }
    state "Report" as P {
        [*] --> P_OPEN
        P_OPEN --> P_UPHELD : admin
        P_OPEN --> P_DISMISSED : admin
    }
```
