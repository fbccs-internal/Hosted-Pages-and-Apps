can pass url param ?append=<base64> to add data to map

run this to convert csv to base64 and paste into param:
{ printf 'v1.'; duckdb -json -c "FROM 'hq.csv'" | gzip -9 -c | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }

csv -> json array -> gzip -> b64 -> url safe

versioned so that we can add dynamic data shape detection and rendering later