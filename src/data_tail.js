
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

/* Registries: the virtual, in-memory address space that !tcxp:/ resolves against.
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
const Q = (id, group, title, intent, uri, ref) => ({id, group, title, intent, uri, ref: ref || null});
const S = '!tcxp:/school.demo/sql/select?';
const F = '!tcxp:/firm.demo/sql/select?';
const enc = s => s.replace(/%/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
const spikes = rows => '~spikes=' + enc(JSON.stringify(rows));
const intent = t => '~intent=' + enc(t);

const MUL_SPIKE = [{id: 's1', on: ['/expr/0/0/0'], meaning: '!tcxp:/registry/notes/implicit-mul', structure: '!tcxp:/registry/rules/implicit-mul', environment: null}];
const EQ = 'expr=eq(add(mul(2,$x),3),9)';
const SEA_SPIKES = [
  {id: 's1', on: ['/$water_temp'], meaning: '!tcxp:/fleet.demo/notes/water-temp', structure: '!tcxp:/fleet.demo/rules/water-temp', environment: null},
  {id: 's2', on: ['/$freezing_point'], meaning: '!tcxp:/fleet.demo/notes/freezing-point', structure: null, environment: '!tcxp:/fleet.demo/env/sea-route'}
];
const SEA = 'expr=lt($water_temp,$freezing_point)';
const TAX_SPIKES = [{id: 's1', on: ['/where/0/1/0', '/$tax_year'], meaning: '!tcxp:/firm.demo/notes/us-hours', structure: '!tcxp:/firm.demo/rules/tax-year', environment: '!tcxp:/firm.demo/env/fiscal-vs-tax'}];
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
    '!tcxp:/registry/math/eval?' + EQ + '&' + intent('Is 2x + 3 = 9 true?') + '&' + spikes(MUL_SPIKE)),
  Q('equation-bound','math','2x + 3 = 9 with x = 3','Is 2x + 3 = 9 true when x = 3?',
    '!tcxp:/registry/math/eval?' + EQ + '&$x=3&' + intent('Is 2x + 3 = 9 true when x = 3?') + '&' + spikes(MUL_SPIKE)),
  Q('ice-gap','math','Ice risk, sea unknown','The water is 29 °F. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&' + intent('The water is 29 °F. Will the sea ice up?') + '&' + spikes(SEA_SPIKES)),
  Q('ice-atlantic','math','Ice risk on the Atlantic route','The water is 29 °F on the Atlantic route. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&$freezing_point=28.6&' + intent('The water is 29 °F on the Atlantic route. Will the sea ice up?') + '&' + spikes(SEA_SPIKES)),
  Q('ice-baltic','math','Ice risk on the Baltic route','The water is 29 °F on the Baltic route. Will the sea ice up?',
    '!tcxp:/fleet.demo/math/eval?' + SEA + '&$water_temp=29&$freezing_point=31.3&' + intent('The water is 29 °F on the Baltic route. Will the sea ice up?') + '&' + spikes(SEA_SPIKES)),
  Q('us-hours-gap','tax','US hours, tax year missing','How many hours did our people work in the US?',
    F + TAX + '&' + intent('How many hours did our people work in the US?') + '&' + spikes(TAX_SPIKES)),
  Q('us-hours-2024','tax','US hours for tax year 2024','How many hours did our people work in the US in tax year 2024?',
    F + TAX + '&$tax_year=2024&' + intent('How many hours did our people work in the US in tax year 2024?') + '&' + spikes(TAX_SPIKES),
    "SELECT sum(work_logs.hours) AS us_hours FROM work_logs WHERE work_logs.work_country = 'US' AND extract(year from work_logs.worked_on) = 2024"),
  Q('us-hours-fy-vs-tax','tax','US hours: calendar year vs fiscal year','How do US hours split between calendar years and project fiscal years?',
    F + "cols=as(year(work_logs.worked_on),calendar_year),projects.fiscal_year,as(sum(work_logs.hours),us_hours)&from=work_logs&join=inner(projects,eq(projects.project_id,work_logs.project_id))&where=eq(work_logs.work_country,$country)&group=year(work_logs.worked_on),projects.fiscal_year&order=asc(calendar_year),asc(projects.fiscal_year)&$country='US'",
    "SELECT extract(year from work_logs.worked_on) AS calendar_year, projects.fiscal_year, sum(work_logs.hours) AS us_hours FROM work_logs INNER JOIN projects ON projects.project_id = work_logs.project_id WHERE work_logs.work_country = 'US' GROUP BY extract(year from work_logs.worked_on), projects.fiscal_year ORDER BY calendar_year ASC, projects.fiscal_year ASC")
];
const GROUPS = [
  ['students','School · students table'],['submissions','School · submissions table'],['joins','School · joins'],
  ['composed','School · composed'],['calls','Calls'],['math','Math and decisions'],['tax','Firm · tax hours']
];
