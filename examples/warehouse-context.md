# Optional warehouse context

Copy this Markdown outside the plugin and fill in the parts relevant to your warehouse. Share that private file with the agent alongside the analysis request. No tool-specific context format is required.

- Billing project and execution location:
- Relevant datasets/tables and ownership:
- Grain and unique keys:
- Known join relationships and expected cardinality:
- Metric definitions, exclusions and business timezones:
- Partition/date filters and usual scan budgets:
- Freshness, ingestion delay and history coverage caveats:
- Known source/schema limitations:
- Useful bounded example queries:

Keep credentials, extracted rows and private definitions out of distributable plugin packages. Business definitions should name their source and distinguish verified rules from working assumptions.
