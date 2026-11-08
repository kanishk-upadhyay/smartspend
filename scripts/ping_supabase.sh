#!/usr/bin/env bash
# SmartSpend — keep-alive ping for Supabase and Replit deployment
# Prevents Supabase Free Tier 7-day inactivity auto-pause by generating
# genuine database activity via the PostgREST API.

SUPABASE_URL="${SUPABASE_URL:-https://latthvnafxgfoiqhgyzq.supabase.co}"
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhdHRodm5hZnhnZm9pcWhneXpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNTI5MzYsImV4cCI6MjA5ODcyODkzNn0.NgwKnIxp_QjJFRm39x4Vgb6_38CleiwodxNPTDS3B4A}"
REPLIT_URL="${REPLIT_URL:-https://smartspend--invincible01.replit.app/health}"

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%SZ")

# 1. Ping Supabase REST endpoint (executes a query against PostgreSQL)
REST_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
  "${SUPABASE_URL}/rest/v1/expenses?limit=1")

# 2. Ping Supabase Auth health endpoint
AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  "${SUPABASE_URL}/auth/v1/health")

# 3. Ping Replit deployment health endpoint
REPLIT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  "${REPLIT_URL}")

echo "[$TIMESTAMP] Keep-alive ping — Supabase DB: ${REST_STATUS}, Supabase Auth: ${AUTH_STATUS}, Replit: ${REPLIT_STATUS}"
