
/* ------------------------------------------------------------- CSV data (v0.2) */
// client.demo: a client's own file of work hours, loaded with registerCSV. The same rows as the tax intake
// demo's sample file, so the two agree: US hours in calendar 2024 = 59.25.
const CLIENT_CSV = `employee,date,hours,work_country
Ana Ruiz,2024-02-12,5,US
Ana Ruiz,2024-03-11,8,US
Ana Ruiz,2024-05-20,6.5,US
Ben Carter,2024-06-03,7,US
Chen Wei,2024-06-10,8,CA
Divya Rao,2024-04-15,7.5,IN
Ana Ruiz,2024-08-05,8,US
Ben Carter,2024-09-16,8,US
Chen Wei,2024-10-07,6,US
Erik Lund,2024-11-12,5,DE
Fatima Noor,2024-12-02,7.25,US
Fatima Noor,2024-12-30,3.5,US
Ana Ruiz,2025-01-13,8,US
Ben Carter,2025-02-24,4,US
Divya Rao,2025-03-10,8,US
Fatima Noor,2025-04-21,6,US
Erik Lund,2025-05-05,8,DE
Chen Wei,2025-06-16,7,CA
Ana Ruiz,2025-07-14,8,US
Ben Carter,2025-08-18,7.5,US
Fatima Noor,2025-09-08,8,US
Divya Rao,2025-09-22,6,IN`;
REGISTRIES['client.demo'] = {title: 'Client file', description: 'A client CSV of work hours, loaded with registerCSV.', fns: {},
  notes: {'rules/tax-year': 'Before submitting, the user must state the tax year they are referencing.'}};
registerCSV('client.demo', 'client_hours', CLIENT_CSV, {hours: 'numeric(6,2)'});
