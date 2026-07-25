# API Agent Instructions

- Authentication middleware applies to every endpoint.
- Validate route params and request bodies before database access.
- Return bounded DTOs and sanitized errors; never echo sensitive inputs.
