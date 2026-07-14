# NotifyHub Project Overview

## Question

> I would like to better understand this project. What problem is NotifyHub designed to solve, what are its primary objectives, and how would it be integrated into a real-world application?

## Overview

NotifyHub is notification infrastructure for software applications. It gives a product one reliable service for delivering notifications through multiple channels, including:

- An in-app inbox
- Email
- SMS
- Real-time WebSocket updates

Instead of implementing email queues, retries, notification preferences, and failure recovery separately, an application submits one event to NotifyHub. For example:

```json
{
  "userId": "user-123",
  "event": "comment.created",
  "payload": {
    "project": "Roadmap",
    "author": "Nina"
  }
}
```

NotifyHub determines which delivery channels are appropriate, renders their templates, respects the user's preferences and quiet hours, retries temporary failures, and records the complete delivery history.

## Practical Applications

A software-as-a-service product could use NotifyHub for:

- Project-management updates, such as comments, assignments, and deadlines
- E-commerce events, such as shipment updates and payment failures
- Banking alerts for transfers or suspicious activity
- Booking confirmations and reminders
- Customer-support replies and escalations
- Internal approval, failure, and incident alerts

The included **Acme Projects** website is a demonstration host. It represents a fictional project-management product so that the NotifyHub inbox widget can be viewed in a realistic context. Acme Projects is not the main product; NotifyHub is the reusable service behind it.

## Reliability Goals

NotifyHub focuses on reliable delivery rather than merely attempting to send a message:

- Repeated API requests do not create duplicate notifications.
- Temporary delivery failures are retried automatically.
- Permanently failed deliveries enter a dead-letter queue for inspection and replay.
- Delivery records are persisted before background work is queued.
- Worker processes can restart without losing notifications.
- Notification data and inbox access are isolated between users.
- Multiple events can be combined into scheduled digests.
- Operators can inspect delivery timelines such as `queued → processing → retrying → sent`.

The high-level flow is:

```text
Application
    ↓ one notification request
NotifyHub API
    ↓
Routing rules and user preferences
    ↓
Email, SMS, and in-app workers
    ↓
User receives the notification
```

## Current Capabilities

The project currently includes:

- An authenticated notification-ingestion API
- PostgreSQL persistence
- Redis and BullMQ background processing
- Email, mock SMS, and in-app delivery
- User preferences and quiet hours
- Delivery retries and dead-letter handling
- Notification digests
- A real-time inbox widget
- The Acme Projects demonstration site
- A sanitized public lifecycle and dead-letter dashboard scoped to a synthetic demo user

The service now includes operational health checks, dependency-aware readiness, Prometheus metrics, structured logs, process-wide graceful shutdown, a production image, and a CI-verified Docker Compose topology behind host Nginx. Later work covers browser testing, performance evidence, and production deployment.

## Summary

NotifyHub is a reusable notification backend that other applications can integrate instead of building and operating their own notification-delivery infrastructure. Its principal value is dependable multi-channel delivery with observable state, controlled retries, and recovery from failures.
