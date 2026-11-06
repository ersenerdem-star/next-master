-- Intermediate price ranks can be badly underestimated for large suppliers.
-- Hash/merge joins avoid quadratic rescans of the ranked CTEs. The bounded
-- lateral index lookup remains a required nested loop, limited to affected SKUs.
alter function supplier_price_usage_internal.refresh_affected_rollups(uuid,uuid) set enable_nestloop=off;
