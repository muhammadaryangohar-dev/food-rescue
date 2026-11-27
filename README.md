# Food Rescue

A Surplus Food Prevention and Redistribution Platform — CSC336 Web Technologies Lab Semester Project, Team 5 (COMSATS University Islamabad).

FoodRescue connects licensed food businesses (restaurants, and marquees / caterers / event venues) with NGOs and volunteers.It works in two tracks:

- **Track A – Prevention:** weekday demand forecast, potential-surplus warning, prevented-food counter.
- **Track B – Rescue:** surplus listings, the Perishability-Aware Allocation Engine (filter, score, pool, lock), OTP-verified pickup and delivery, impact reporting.

## Team

| Member | Registration No. | Area |
|---|---|---|
| Muhammad Aryan Gohar | FA24-BCS-060 | Back-end, schema, auth, allocation locking, expiry sweep |
| Fatima Niazi | FA24-BCS-116 | Matching engine, forecast, events, impact, fairness, seeds |
| Sunaina Sulaifa | FA24-BCS-098 | React front-end, dashboards, OTP screens, map, testing, docs |

## Tech stack

- **Front-end:** React (Vite), Tailwind CSS, React Router, Recharts, Leaflet + OpenStreetMap
- **Back-end:** Node.js, Express.js (modular monolith)
- **Database:** PostgreSQL with Prisma ORM
- **Auth/Security:** JWT, bcrypt, Zod, rate limiting
- **Testing:** Jest/Vitest, Postman
- **Deployment:** Vercel (front-end), Render (back-end), Neon (PostgreSQL)

## Repository structure

```
food-rescue/
├── backend/
│   ├── prisma/            # schema.prisma, migrations
│   ├── scripts/           # seed, demo-reset, concurrency demo
│   ├── tests/             # automated tests
│   └── src/
│       ├── config/
│       ├── middleware/    # auth, roles, validation, rate limiting
│       ├── lib/           # prisma client, haversine, helpers
│       └── modules/
│           ├── access/              # M1  Access and Accounts
│           ├── food-prevention/     # M2  Food and Prevention
│           ├── events/              # M3  Events
│           ├── listings/            # M4  Listings
│           ├── matching/            # M5  Requests and Matching
│           ├── allocations/         # M6  Allocations
│           ├── rescue/              # M7  Rescue
│           ├── location/            # M8  Location and Map
│           ├── impact/              # M9  Impact and Analytics
│           ├── fairness/            # M10 Fairness
│           ├── tracking/            # M11 Tracking, Log and Reports
│           └── notifications-admin/ # M12 Notifications and Admin Controls
├── frontend/
│   ├── public/
│   └── src/
│       ├── api/  components/  context/  hooks/  layouts/
│       └── pages/ (auth, donor, ngo, volunteer, admin)
└── docs/
    ├── api/        # API contract
    ├── diagrams/   # ER diagram, state machines
    └── postman/    # Postman collection
```

