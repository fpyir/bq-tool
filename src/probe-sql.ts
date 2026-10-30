// A fixed, table-free query: milestone 0 does not accept arbitrary SQL.
export const PROBE_SQL = `SELECT
  CAST('9223372036854775807' AS INT64) AS integer_value,
  NUMERIC '12345678901234567890.123456789' AS numeric_value,
  BIGNUMERIC '12345678901234567890123456789012345678.12345678901234567890123456789012345678' AS big_numeric_value,
  1.25 AS float_value,
  TRUE AS boolean_value,
  'hello, BigQuery → DuckDB' AS string_value,
  CAST(NULL AS STRING) AS null_value,
  TIMESTAMP '2026-01-02 03:04:05.123456+00' AS timestamp_value,
  DATE '2026-01-02' AS date_value,
  DATETIME '2026-01-02 03:04:05.123456' AS datetime_value,
  TIME '03:04:05.123456' AS time_value,
  [CAST('9007199254740993' AS INT64), -1] AS array_value,
  ARRAY<INT64>[] AS empty_array_value,
  STRUCT('nested' AS label, CAST('9007199254740993' AS INT64) AS count) AS struct_value,
  JSON '{"large":9223372036854775807,"enabled":true}' AS json_value`;

export const PROBE_CHECK_SQL = `SELECT
  integer_value = 9223372036854775807::BIGINT AS integer_exact,
  numeric_value = 12345678901234567890.123456789::DECIMAL(38,9) AS numeric_exact,
  big_numeric_value = '12345678901234567890123456789012345678.12345678901234567890123456789012345678' AS big_numeric_exact_text,
  float_value = 1.25 AS float_exact,
  boolean_value = TRUE AS boolean_exact,
  string_value = 'hello, BigQuery → DuckDB' AS string_exact,
  null_value IS NULL AS null_preserved,
  epoch_us(timestamp_value) = 1767323045123456 AS timestamp_microseconds_exact,
  date_value = DATE '2026-01-02' AS date_exact,
  datetime_value = TIMESTAMP '2026-01-02 03:04:05.123456' AS datetime_exact,
  time_value = TIME '03:04:05.123456' AS time_exact,
  array_value = [9007199254740993::BIGINT, -1::BIGINT] AS array_exact,
  len(empty_array_value) = 0 AS empty_array_preserved,
  struct_value.label = 'nested' AND struct_value.count = 9007199254740993::BIGINT AS struct_exact,
  json_extract_string(json_value, '$.large') = '9223372036854775807'
    AND json_extract_string(json_value, '$.enabled') = 'true' AS json_exact
FROM probe_input`;
