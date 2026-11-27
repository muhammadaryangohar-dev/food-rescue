// Express application (modular monolith: one folder per module under src/modules).
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { sweepOnRead } from './modules/allocations/sweep.service.js';
import './modules/matching/matching.service.js'; // Member 2: registers the matching engine

import accessRoutes from './modules/access/access.routes.js';
import categoryRoutes from './modules/listings/category.routes.js';
import listingRoutes from './modules/listings/listing.routes.js';
import requestRoutes from './modules/matching/request.routes.js';
import allocationRoutes from './modules/allocations/allocation.routes.js';
import rescueRoutes from './modules/rescue/rescue.routes.js';
import reportRoutes from './modules/tracking/report.routes.js';
import notificationRoutes from './modules/notifications-admin/notification.routes.js';
import adminRoutes from './modules/notifications-admin/admin.routes.js';
import locationRoutes from './modules/location/location.routes.js';
import ngoDirectoryRoutes from './modules/location/ngo-directory.routes.js';
import reliabilityRoutes from './modules/tracking/reliability.routes.js';
import foodPreventionRoutes from './modules/food-prevention/food.routes.js'; // Member 2
import eventRoutes from './modules/events/event.routes.js'; // Member 2
import impactRoutes from './modules/impact/impact.routes.js'; // Member 2
import fairnessRoutes from './modules/fairness/fairness.routes.js'; // Member 2

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  if (env.NODE_ENV === 'development') app.use(morgan('dev'));

  app.get('/api/health', async (_req, res) => {
    let database = 'up';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    res.status(database === 'up' ? 200 : 503).json({ status: 'ok', database, time: new Date().toISOString() });
  });

  app.use('/api', apiLimiter);
  app.use('/api', sweepOnRead); // expire-on-read: cheap check before GET requests

  app.use('/api/auth', accessRoutes);
  app.use('/api/categories', categoryRoutes);
  app.use('/api/areas', locationRoutes);
  app.use('/api/ngos', ngoDirectoryRoutes); // public NGO directory for households
  app.use('/api/listings', listingRoutes);
  app.use('/api/requests', requestRoutes);
  app.use('/api/allocations', allocationRoutes);
  app.use('/api/tasks', rescueRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/reliability', reliabilityRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/admin', adminRoutes);

  // ---- Member 2 modules
  app.use('/api/food', foodPreventionRoutes); // M2 forecast and prevention
  app.use('/api/events', eventRoutes); // M3 events
  app.use('/api/impact', impactRoutes); // M9 impact
  app.use('/api/fairness', fairnessRoutes); // M10 fairness

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
