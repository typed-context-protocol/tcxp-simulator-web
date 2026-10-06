
const FIRM_SCHEMA = {
  name: 'firm',
  description: 'A consulting firm: employees log hours against client projects. Projects are booked to a July–June fiscal year; tax returns use the calendar year.',
  tables: [
    { name: 'employees', description: 'One row per person. home_country is where they are based, not where they worked.',
      columns: [
        ['employee_id','integer','PRIMARY KEY','Surrogate key.'],
        ['full_name','text','NOT NULL','Display name.'],
        ['home_country','text','NOT NULL','ISO country code of the home office.'] ] },
    { name: 'projects', description: 'Client engagements. fiscal_year names the fiscal year (July 1 to June 30) the project is booked to, named for the year it ends.',
      columns: [
        ['project_id','integer','PRIMARY KEY','Surrogate key.'],
        ['code','text','NOT NULL UNIQUE','Project code, e.g. P-ATLAS.'],
        ['client','text','NOT NULL','Client name.'],
        ['fiscal_year','integer','NOT NULL','Company fiscal year, July–June, named for the year it ends. FY2025 = 2024-07-01 to 2025-06-30.'] ] },
    { name: 'work_logs', description: 'One row per day of logged work. work_country is where the work was physically performed.',
      columns: [
        ['log_id','integer','PRIMARY KEY','Surrogate key.'],
        ['employee_id','integer','NOT NULL REFERENCES employees(employee_id)','Who worked.'],
        ['project_id','integer','NOT NULL REFERENCES projects(project_id)','Project the hours are billed to.'],
        ['worked_on','date','NOT NULL','Calendar date of the work.'],
        ['hours','numeric(5,2)','NOT NULL CHECK (hours > 0)','Hours worked that day.'],
        ['work_country','text','NOT NULL','ISO country code where the work was physically performed.'] ] }
  ]
};
const FIRM_SEED = {
  employees: [[1,'Ana Ruiz','US'],[2,'Ben Carter','US'],[3,'Chen Wei','CA'],[4,'Divya Rao','IN'],[5,'Erik Lund','DE'],[6,'Fatima Noor','US']],
  projects: [[1,'P-ATLAS','Northwind Logistics',2024],[2,'P-BEACON','Bluefin Retail',2025],[3,'P-CEDAR','Cedar Health',2025],[4,'P-DELTA','Delta Mills',2026]],
  work_logs: [
    [1,1,1,'2024-03-11',8,'US'],[2,1,1,'2024-05-20',6.5,'US'],[3,2,1,'2024-06-03',7,'US'],[4,3,1,'2024-06-10',8,'CA'],
    [5,4,1,'2024-04-15',7.5,'IN'],[6,1,2,'2024-08-05',8,'US'],[7,2,2,'2024-09-16',8,'US'],[8,3,2,'2024-10-07',6,'US'],
    [9,5,2,'2024-11-12',5,'DE'],[10,6,2,'2024-12-02',7.25,'US'],[11,1,3,'2025-01-13',8,'US'],[12,2,3,'2025-02-24',4,'US'],
    [13,4,3,'2025-03-10',8,'US'],[14,6,3,'2025-04-21',6,'US'],[15,5,3,'2025-05-05',8,'DE'],[16,3,3,'2025-06-16',7,'CA'],
    [17,1,4,'2025-07-14',8,'US'],[18,2,4,'2025-08-18',7.5,'US'],[19,6,4,'2025-09-08',8,'US'],[20,4,4,'2025-09-22',6,'IN'],
    [21,6,2,'2024-12-30',3.5,'US'],[22,2,1,'2024-02-12',5,'US']
  ]
};

/* Registries: the virtual, in-memory address space that !tcxp:/ addresses name (they are not resolved).
   Each registry may hold a database (sql/select), functions (callable with @) and notes
   (facet content that annotations point to). math/eval is available in every registry. */
const REGISTRIES = {
  'school.demo': {
    title: 'School', description: 'Learning platform database.',
    db: {schema: SCHOOL_SCHEMA, seed: SCHOOL_SEED},
    fns: {
      'fn/current_cohort': {params: [], returns: 'text', doc: 'Returns the intake term currently open for enrollment.', fn: () => '2026-fall'}
    },
    notes: {}
  },
  'firm.demo': {
    title: 'Firm', description: 'Consulting firm time-tracking database.',
    db: {schema: FIRM_SCHEMA, seed: FIRM_SEED},
    fns: {},
    notes: {
      'notes/us-hours': 'Total hours physically worked inside the United States, by every employee, wherever they are based.',
      'rules/tax-year': 'A tax-year question must bind $tax_year. Filter on the calendar year of work_logs.worked_on, never on projects.fiscal_year.',
      'env/fiscal-vs-tax': 'Projects are booked to a July–June fiscal year. A FY2025 project has hours in calendar 2024 and 2025. Ask which tax year the return is for; do not infer it from the project.'
    }
  },
  'fleet.demo': {
    title: 'Fleet', description: 'Ship sensor readings and routing notes.',
    fns: {},
    notes: {
      'notes/water-temp': 'Sea-surface water temperature reported by the hull sensor.',
      'rules/water-temp': 'Degrees Fahrenheit, whole number, truncated toward zero. Sensor range 24–95 °F.',
      'notes/freezing-point': 'The temperature at which seawater starts to freeze. It depends on salinity.',
      'env/sea-route': 'The freezing point depends on the sea. Atlantic water (about 35 PSU) freezes near 28.6 °F; Baltic surface water (about 7 PSU) freezes near 31.3 °F. Bind $freezing_point from the route, never from a default.'
    }
  },
  'registry': {
    title: 'Shared registry', description: 'Shared functions and notes.',
    fns: {
      'hello': {params: [{name: 'do', type: 'text'}], returns: 'text', doc: 'Greets whatever you pass in do.', fn: a => 'hello, ' + a.do}
    },
    notes: {
      'notes/implicit-mul': 'In written math, 2x is shorthand for 2 × x. The tree always stores the multiplication explicitly.',
      'rules/implicit-mul': 'Normalization rule: a number written directly before a variable means mul(number, variable). Both written forms map to the same tree.',
      'notes/equation': 'A linear equation in one unknown, x. It holds when x = 3.'
    }
  }
};

/* ---------------------------------------------------------------- queries */
// Every collection address is a full address: it ends with ~context (empty unless the entry gives one).
const Q = (id, group, title, intent, uri, ref) => ({id, group, title, intent, uri: uri.includes('~context=') ? uri : uri + (uri.includes('?') ? '&' : '?') + ctx({}), ref: ref || null});
const S = '!tcxp:/school.demo/sql/select?';
const F = '!tcxp:/firm.demo/sql/select?';
const W = '!tcxp:/school.demo/sql/';
const WF = '!tcxp:/firm.demo/sql/';
const C = '!tcxp:/client.demo/sql/select?';
const CSV_TAX = "cols=as(sum(hours),us_hours)&from=client_hours&where=and(eq(work_country,'US'),eq(year(date),$tax_year))";
const USER_ROW = {role: 'user', text: 'What are the US hours worked in my client CSV?'};
const MANAGER_ROW = {role: 'manager', text: 'Before submitting, the user must state the tax year they are referencing.', require: '$tax_year', if_empty: 'HALT'};
const enc = s => s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
// ~context: the five arrays in their fixed order, written compactly.
const ctx = p => '~context=' + enc(JSON.stringify({intent: p.intent || [], observe: p.observe || [], reason: [], decide: [], trace: p.trace || []}));
// The handlers' convention for a plain question: one intent row {role:"user", text}.
const userRow = text => ({role: 'user', text});

const MUL_SPIKE = [{on: ['/expr/0/0/0'], meaning: '!tcxp:/registry/notes/implicit-mul', structure: '!tcxp:/registry/rules/implicit-mul', environment: null}];
const EQ = 'expr=eq(add(mul(2,$x),3),9)';
const SEA_SPIKES = [
  {on: ['/$water_temp'], meaning: '!tcxp:/fleet.demo/notes/water-temp', structure: '!tcxp:/fleet.demo/rules/water-temp', environment: null},
  {on: ['/$freezing_point'], meaning: '!tcxp:/fleet.demo/notes/freezing-point', structure: null, environment: '!tcxp:/fleet.demo/env/sea-route'}
];
const SEA = 'expr=lt($water_temp,$freezing_point)';
const TAX_SPIKES = [{on: ['/where/0/1/0', '/$tax_year'], meaning: '!tcxp:/firm.demo/notes/us-hours', structure: '!tcxp:/firm.demo/rules/tax-year', environment: '!tcxp:/firm.demo/env/fiscal-vs-tax'}];
const TAX = "cols=as(sum(work_logs.hours),us_hours)&from=work_logs&where=and(eq(work_logs.work_country,'US'),eq(year(work_logs.worked_on),$tax_year))";

const QUERIES = [
  Q('students-by-cohort','students','Students in a cohort','Show me everyone in the fall 2026 cohort.',
    S + "cols=*&from=students&where=eq(cohort,$cohort)&$cohort='2026-fall'",
    "SELECT * FROM students WHERE cohort = '2026-fall'"),
  Q('top-gpa','students','Top students by GPA','Who are the top 5 students with at least a 3.5 GPA?',
    S + 'cols=first_name,last_name,gpa&from=students&where=ge(gpa,$min_gpa)&order=desc(gpa)&limit=$top&$min_gpa=3.5&$top=5',
    'SELECT first_name, last_name, gpa FROM students WHERE gpa >= 3.5 ORDER BY gpa DESC LIMIT 5'),
  Q('joined-in-window','students','Students who joined in a date window','Who joined the platform during August 2026?',
    S + "cols=student_id,email,enrolled_on&from=students&where=between(enrolled_on,$start,$end)&order=asc(enrolled_on)&$start=date'2026-08-01'&$end=date'2026-08-31'",
    "SELECT student_id, email, enrolled_on FROM students WHERE enrolled_on BETWEEN DATE '2026-08-01' AND DATE '2026-08-31' ORDER BY enrolled_on ASC"),
  Q('ungraded-since','submissions','Ungraded work since a date','What has been submitted since September 15 that still has no grade?',
    S + "cols=*&from=submissions&where=and(ge(submitted_at,$since),isnull(score))&$since=date'2026-09-15'",
    "SELECT * FROM submissions WHERE submitted_at >= DATE '2026-09-15' AND score IS NULL"),
  Q('avg-per-assignment','submissions','Average score per assignment','For assignments with at least 3 submissions, what is the average score?',
    S + 'cols=assignment_id,as(round(avg(score),1),avg_score),as(count(*),n)&from=submissions&group=assignment_id&having=ge(count(*),$min_n)&order=desc(avg_score)&$min_n=3',
    'SELECT assignment_id, round(avg(score), 1) AS avg_score, count(*) AS n FROM submissions GROUP BY assignment_id HAVING count(*) >= 3 ORDER BY avg_score DESC'),
  Q('late-and-low','submissions','Late or resubmitted work scoring low','Which late or resubmitted submissions scored under 70?',
    S + "cols=submission_id,student_id,score,status&from=submissions&where=and(in(status,'late','resubmitted'),lt(score,$threshold))&$threshold=70",
    "SELECT submission_id, student_id, score, status FROM submissions WHERE status IN ('late', 'resubmitted') AND score < 70"),
  Q('roster-inner','joins','Course roster (inner join)','Who is enrolled in CS101?',
    S + "cols=students.first_name,students.last_name,courses.title&from=students&join=inner(enrollments,eq(enrollments.student_id,students.student_id))&join=inner(courses,eq(courses.course_id,enrollments.course_id))&where=eq(courses.code,$course_code)&$course_code='CS101'",
    "SELECT students.first_name, students.last_name, courses.title FROM students INNER JOIN enrollments ON enrollments.student_id = students.student_id INNER JOIN courses ON courses.course_id = enrollments.course_id WHERE courses.code = 'CS101'"),
  Q('no-submissions-left','joins','Students with no submissions (left join)','Which students have never submitted anything?',
    S + 'cols=students.student_id,students.email&from=students&join=left(submissions,eq(submissions.student_id,students.student_id))&where=isnull(submissions.submission_id)',
    'SELECT students.student_id, students.email FROM students LEFT JOIN submissions ON submissions.student_id = students.student_id WHERE submissions.submission_id IS NULL'),
  Q('unmatched-full','joins','Courses and assignments without a partner (full outer join)','Which courses have no assignments, and which assignments belong to no course?',
    S + 'cols=courses.code,assignments.title&from=courses&join=full(assignments,eq(assignments.course_id,courses.course_id))&where=or(isnull(courses.course_id),isnull(assignments.assignment_id))',
    'SELECT courses.code, assignments.title FROM courses FULL OUTER JOIN assignments ON assignments.course_id = courses.course_id WHERE courses.course_id IS NULL OR assignments.assignment_id IS NULL'),
  Q('dept-enrollment','composed','Active enrollment by department','How many active enrollments does each department have?',
    S + "cols=courses.department,as(count(enrollments.enrollment_id),enrolled)&from=courses&join=left(enrollments,and(eq(enrollments.course_id,courses.course_id),eq(enrollments.status,$status)))&group=courses.department&order=desc(enrolled),asc(courses.department)&$status='active'",
    "SELECT courses.department, count(enrollments.enrollment_id) AS enrolled FROM courses LEFT JOIN enrollments ON enrollments.course_id = courses.course_id AND enrollments.status = 'active' GROUP BY courses.department ORDER BY enrolled DESC, courses.department ASC"),
  Q('hello-call','calls','Hello, world (call)','Call the hello handler with do=world.',
    '@!tcxp:/registry/hello?do=world'),
  Q('cohort-from-call','calls','Cohort bound by a call','Show me everyone in the cohort that is open for enrollment right now.',
    S + 'cols=*&from=students&where=eq(cohort,$cohort)&$cohort=@!tcxp:/school.demo/fn/current_cohort',
    "SELECT * FROM students WHERE cohort = '2026-fall'"),
  Q('equation-gap','math','2x + 3 = 9 with x unknown','Is 2x + 3 = 9 true?',
    '!tcxp:/registry/math/eval?' + EQ + '&' + ctx({intent: [userRow('Is 2x + 3 = 9 true?')], observe: MUL_SPIKE})),
  Q('equation-bound','math','2x + 3 = 9 with x = 3','Is 2x + 3 = 9 true when x = 3?',
    '!tcxp:/registry/math/eval?' + EQ + '&$x=3&' + ctx({intent: [userRow('Is 2x + 3 = 9 true when x = 3?')], observe: MUL_SPIKE})),
  Q('ice-gap','math','Ice risk, sea unknown','The water is 29 °F. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&' + ctx({intent: [userRow('The water is 29 °F. Will the sea ice up?')], observe: SEA_SPIKES})),
  Q('ice-atlantic','math','Ice risk on the Atlantic route','The water is 29 °F on the Atlantic route. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&$freezing_point=28.6&' + ctx({intent: [userRow('The water is 29 °F on the Atlantic route. Will the sea ice up?')], observe: SEA_SPIKES})),
  Q('ice-baltic','math','Ice risk on the Baltic route','The water is 29 °F on the Baltic route. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&$freezing_point=31.3&' + ctx({intent: [userRow('The water is 29 °F on the Baltic route. Will the sea ice up?')], observe: SEA_SPIKES})),
  Q('us-hours-gap','tax','US hours, tax year missing','How many hours did our people work in the US?',
    F + TAX + '&' + ctx({intent: [userRow('How many hours did our people work in the US?')], observe: TAX_SPIKES})),
  Q('us-hours-2024','tax','US hours for tax year 2024','How many hours did our people work in the US in tax year 2024?',
    F + TAX + '&$tax_year=2024&' + ctx({intent: [userRow('How many hours did our people work in the US in tax year 2024?')], observe: TAX_SPIKES}),
    "SELECT sum(work_logs.hours) AS us_hours FROM work_logs WHERE work_logs.work_country = 'US' AND extract(year from work_logs.worked_on) = 2024"),
  Q('us-hours-fy-vs-tax','tax','US hours: calendar year vs fiscal year','How do US hours split between calendar years and project fiscal years?',
    F + "cols=as(year(work_logs.worked_on),calendar_year),projects.fiscal_year,as(sum(work_logs.hours),us_hours)&from=work_logs&join=inner(projects,eq(projects.project_id,work_logs.project_id))&where=eq(work_logs.work_country,$country)&group=year(work_logs.worked_on),projects.fiscal_year&order=asc(calendar_year),asc(projects.fiscal_year)&$country='US'",
    "SELECT extract(year from work_logs.worked_on) AS calendar_year, projects.fiscal_year, sum(work_logs.hours) AS us_hours FROM work_logs INNER JOIN projects ON projects.project_id = work_logs.project_id WHERE work_logs.work_country = 'US' GROUP BY extract(year from work_logs.worked_on), projects.fiscal_year ORDER BY calendar_year ASC, projects.fiscal_year ASC"),
  // v0.2 writes. Without @ each address is a proposed write (preview); with @ it runs.
  Q('write-insert-one','writes','Add a course (insert one row)','Add the new Data Visualization course, DS310, worth 3 credits.',
    W + "insert?into=courses&cols=course_id,code,title,department,credits&values=row(6,'DS310','Data Visualization','DS',$credits)&returning=*&$credits=3",
    "INSERT INTO courses (course_id, code, title, department, credits) VALUES (6, 'DS310', 'Data Visualization', 'DS', 3) RETURNING *"),
  Q('write-insert-many','writes','Enroll a student in two courses (insert several rows)','Enroll Hannah Weiss in CS101 and DS210 today.',
    W + "insert?into=enrollments&cols=enrollment_id,student_id,course_id,enrolled_at,status&values=row(21,$student,1,$today,'active'),row(22,$student,3,$today,'active')&returning=enrollment_id,course_id&$student=5&$today=date'2026-10-04'",
    "INSERT INTO enrollments (enrollment_id, student_id, course_id, enrolled_at, status) VALUES (21, 5, 1, DATE '2026-10-04', 'active'), (22, 5, 3, DATE '2026-10-04', 'active') RETURNING enrollment_id, course_id"),
  Q('write-update-bound','writes','Record a new GPA (update with bound variables)',"Record Noah Kim's new GPA of 3.15.",
    W + 'update?table=students&set=assign(gpa,$gpa)&where=eq(student_id,$id)&returning=student_id,first_name,gpa&$gpa=3.15&$id=8',
    'UPDATE students SET gpa = 3.15 WHERE student_id = 8 RETURNING student_id, first_name, gpa'),
  Q('write-update-call','writes','Move a student to the open cohort (update bound by a call)','Move Priya Nair into the cohort that is open for enrollment now.',
    W + 'update?table=students&set=assign(cohort,$cohort)&where=eq(student_id,3)&returning=student_id,cohort&$cohort=@!tcxp:/school.demo/fn/current_cohort',
    "UPDATE students SET cohort = '2026-fall' WHERE student_id = 3 RETURNING student_id, cohort"),
  Q('write-delete-where','writes','Delete low late submissions (delete with where)','Delete the late submissions that scored under 60.',
    W + "delete?from=submissions&where=and(eq(status,'late'),lt(score,$below))&returning=submission_id,score&$below=60",
    "DELETE FROM submissions WHERE status = 'late' AND score < 60 RETURNING submission_id, score"),
  Q('write-update-expr','writes','Add half an hour to a work log (update with an expression)',"Add half an hour to Ana Ruiz's work log for May 20, 2024.",
    WF + 'update?table=work_logs&set=assign(hours,add(hours,$extra))&where=eq(log_id,2)&returning=log_id,hours&$extra=0.5',
    'UPDATE work_logs SET hours = hours + 0.5 WHERE log_id = 2 RETURNING log_id, hours'),
  Q('write-delete-all','writes','Clear every submission on purpose (where=true)','Clear every submission. Yes, all of them.',
    W + 'delete?from=submissions&where=true&returning=submission_id',
    'DELETE FROM submissions WHERE true RETURNING submission_id'),
  Q('write-update-gap','writes','Set a GPA, value missing (gap blocks the write)',"Set Maya Chen's GPA.",
    W + 'update?table=students&set=assign(gpa,$gpa)&where=eq(student_id,1)'),
  Q('write-delete-no-where','writes','Delete with no where (refused)','Delete every submission.',
    W + 'delete?from=submissions'),
  Q('write-fk-violation','writes','Enroll a student who does not exist (foreign key error)','Enroll student 99 in CS101.',
    W + "insert?into=enrollments&cols=enrollment_id,student_id,course_id,enrolled_at,status&values=row(21,99,1,date'2026-10-04','active')",
    "INSERT INTO enrollments (enrollment_id, student_id, course_id, enrolled_at, status) VALUES (21, 99, 1, DATE '2026-10-04', 'active')"),
  // v0.2 CSV data source: client.demo/client_hours is loaded from a CSV with registerCSV (see data_csv.js).
  Q('csv-us-hours-2024','csv','US hours in the client CSV, tax year 2024','What are the US hours worked in my client CSV in 2024?',
    C + "cols=as(sum(hours),us_hours)&from=client_hours&where=and(eq(work_country,'US'),eq(year(date),$tax_year))&$tax_year=2024",
    "SELECT sum(hours) AS us_hours FROM client_hours WHERE work_country = 'US' AND extract(year from date) = 2024"),
  Q('csv-hours-by-employee','csv','Hours per person in the client CSV','How many hours did each person log, and where?',
    C + 'cols=employee,work_country,as(sum(hours),total_hours),as(count(*),days)&from=client_hours&group=employee,work_country&order=asc(employee),asc(work_country)',
    'SELECT employee, work_country, sum(hours) AS total_hours, count(*) AS days FROM client_hours GROUP BY employee, work_country ORDER BY employee ASC, work_country ASC'),
  Q('csv-insert-row','csv','Add a day to the client CSV (write)','Add a 6-hour US day for Ana Ruiz on 2025-10-01.',
    '!tcxp:/client.demo/sql/insert?into=client_hours&cols=row_id,employee,date,hours,work_country&values=row(23,$who,$day,6,\'US\')&returning=*&$who=\'Ana Ruiz\'&$day=date\'2025-10-01\'',
    "INSERT INTO client_hours (row_id, employee, date, hours, work_country) VALUES (23, 'Ana Ruiz', DATE '2025-10-01', 6, 'US') RETURNING *"),
  // v0.2 intent rows: ~intent as an array. The manager's row requires $tax_year; until it is bound the address halts.
  Q('intent-halt','intent','US hours: halts until the tax year is stated','What are the US hours worked in my client CSV?',
    C + CSV_TAX + '&' + ctx({intent: [USER_ROW, MANAGER_ROW]})),
  Q('intent-answered','intent','US hours: tax year given, it runs','What are the US hours worked in my client CSV? (2024)',
    C + CSV_TAX + '&$tax_year=2024&' + ctx({intent: [USER_ROW, MANAGER_ROW]}),
    "SELECT sum(hours) AS us_hours FROM client_hours WHERE work_country = 'US' AND extract(year from date) = 2024"),
  // Resolvable: a registry entry that points to an external location (see data_resolvable.js). Reading shows the
  // location; only an explicit resolve fetches the content. The virtual note with the same path is a different state.
  Q('resolvable-tax-year','resolvable','Resolvable entry: the tax-year rule','Where does tcxp://firm.demo/rules/tax-year point?',
    'tcxp://firm.demo/rules/tax-year')
];
const GROUPS = [
  ['students','School · students table'],['submissions','School · submissions table'],['joins','School · joins'],
  ['composed','School · composed'],['calls','Calls'],['math','Math and decisions'],['tax','Firm · tax hours'],['writes','Writes'],['csv','Client CSV'],['intent','Intent rows'],['resolvable','Resolvable (tcxp://)']
];
