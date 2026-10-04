const SCHOOL_SCHEMA = {
  name: 'school',
  description: 'A small learning platform: students enroll in courses, courses publish assignments, students submit work that gets graded.',
  tables: [
    { name: 'students', description: 'One row per learner. Cohort groups students by intake term.',
      columns: [
        ['student_id','integer','PRIMARY KEY','Surrogate key.'],
        ['first_name','text','NOT NULL','Given name.'],
        ['last_name','text','NOT NULL','Family name.'],
        ['email','text','NOT NULL UNIQUE','Login and contact address.'],
        ['cohort','text','NOT NULL','Intake term, e.g. 2026-fall.'],
        ['gpa','numeric(3,2)',"CHECK (gpa BETWEEN 0 AND 4)",'Cumulative grade point average, 0.00 to 4.00.'],
        ['enrolled_on','date','NOT NULL','Date the student joined the platform.'] ] },
    { name: 'courses', description: 'Catalog of courses. A course may have no assignments yet.',
      columns: [
        ['course_id','integer','PRIMARY KEY','Surrogate key.'],
        ['code','text','NOT NULL UNIQUE','Catalog code, e.g. CS101.'],
        ['title','text','NOT NULL','Display title.'],
        ['department','text','NOT NULL','Owning department.'],
        ['credits','integer','NOT NULL CHECK (credits > 0)','Credit hours.'] ] },
    { name: 'enrollments', description: 'Bridge table: which student is in which course, and their status.',
      columns: [
        ['enrollment_id','integer','PRIMARY KEY','Surrogate key.'],
        ['student_id','integer','NOT NULL REFERENCES students(student_id)','Enrolled student.'],
        ['course_id','integer','NOT NULL REFERENCES courses(course_id)','Course enrolled in.'],
        ['enrolled_at','date','NOT NULL','Date of enrollment.'],
        ['status','text',"NOT NULL CHECK (status IN ('active','dropped','completed'))",'Lifecycle state.'] ] },
    { name: 'assignments', description: 'Gradable work. course_id is NULL for items still in the shared assignment bank.',
      columns: [
        ['assignment_id','integer','PRIMARY KEY','Surrogate key.'],
        ['course_id','integer','REFERENCES courses(course_id)','Owning course; NULL while unattached in the bank.'],
        ['title','text','NOT NULL','Display title.'],
        ['max_points','integer','NOT NULL','Maximum achievable score.'],
        ['due_on','date','','Due date; NULL for bank items.'] ] },
    { name: 'submissions', description: 'One row per submitted attempt. score is NULL until graded.',
      columns: [
        ['submission_id','integer','PRIMARY KEY','Surrogate key.'],
        ['assignment_id','integer','NOT NULL REFERENCES assignments(assignment_id)','Assignment submitted against.'],
        ['student_id','integer','NOT NULL REFERENCES students(student_id)','Submitting student.'],
        ['submitted_at','timestamptz','NOT NULL','When the work arrived.'],
        ['score','numeric(5,2)','','Points awarded; NULL until graded.'],
        ['status','text',"NOT NULL CHECK (status IN ('on_time','late','resubmitted'))",'Timeliness of the submission.'] ] }
  ]
};

const SCHOOL_SEED = {
  students: [
    [1,'Maya','Chen','maya.chen@school.demo','2026-fall',3.92,'2026-08-12'],
    [2,'Diego','Alvarez','diego.alvarez@school.demo','2026-fall',3.78,'2026-08-14'],
    [3,'Priya','Nair','priya.nair@school.demo','2026-spring',3.55,'2026-01-10'],
    [4,'Samuel','Okafor','samuel.okafor@school.demo','2026-fall',3.88,'2026-08-20'],
    [5,'Hannah','Weiss','hannah.weiss@school.demo','2025-fall',3.10,'2025-08-18'],
    [6,'Luca','Rossi','luca.rossi@school.demo','2026-fall',3.67,'2026-09-02'],
    [7,'Amara','Diallo','amara.diallo@school.demo','2026-spring',3.95,'2026-01-08'],
    [8,'Noah','Kim','noah.kim@school.demo','2026-fall',2.95,'2026-08-28'],
    [9,'Sofia','Petrov','sofia.petrov@school.demo','2025-fall',3.40,'2025-08-22'],
    [10,'Ethan','Brooks','ethan.brooks@school.demo','2026-fall',3.20,'2026-08-05'],
    [11,'Leila','Haddad','leila.haddad@school.demo','2026-spring',2.80,'2026-01-15'],
    [12,'Oliver','Grant','oliver.grant@school.demo','2026-fall',3.71,'2026-09-05']
  ],
  courses: [
    [1,'CS101','Intro to Programming','CS',4],
    [2,'MATH140','Discrete Mathematics','MATH',3],
    [3,'DS210','Data Engineering Foundations','DS',4],
    [4,'STAT200','Applied Statistics','MATH',3],
    [5,'HCI150','Human-Computer Interaction','CS',3]
  ],
  enrollments: [
    [1,1,1,'2026-08-25','active'],[2,1,3,'2026-08-25','active'],[3,2,1,'2026-08-26','active'],
    [4,2,2,'2026-08-26','dropped'],[5,3,3,'2026-01-20','completed'],[6,3,4,'2026-08-27','active'],
    [7,4,1,'2026-08-27','active'],[8,4,3,'2026-08-27','active'],[9,5,2,'2025-09-01','completed'],
    [10,6,1,'2026-09-03','active'],[11,6,5,'2026-09-03','active'],[12,7,3,'2026-01-18','completed'],
    [13,7,4,'2026-08-28','active'],[14,8,1,'2026-08-30','active'],[15,9,4,'2025-09-02','completed'],
    [16,10,2,'2026-08-25','active'],[17,10,3,'2026-08-25','active'],[18,11,5,'2026-01-22','dropped'],
    [19,12,1,'2026-09-06','active'],[20,12,4,'2026-09-06','active']
  ],
  assignments: [
    [1,1,'Variables and types',100,'2026-09-12'],[2,1,'Control flow',100,'2026-09-26'],
    [3,2,'Proof techniques',50,'2026-09-19'],[4,3,'Schema design',100,'2026-09-15'],
    [5,3,'SQL joins lab',100,'2026-09-29'],[6,4,'Sampling quiz',20,'2026-09-18'],
    [7,null,'Ethics in data',50,null],[8,null,'Capstone proposal template',100,null]
  ],
  submissions: [
    [1,1,1,'2026-09-11 21:04:00+00',96,'on_time'],[2,1,2,'2026-09-12 23:40:00+00',88,'on_time'],
    [3,1,4,'2026-09-13 10:15:00+00',64,'late'],[4,1,6,'2026-09-12 08:00:00+00',91,'on_time'],
    [5,1,12,'2026-09-14 19:30:00+00',58,'late'],[6,2,1,'2026-09-25 17:00:00+00',null,'on_time'],
    [7,2,2,'2026-09-27 09:12:00+00',null,'late'],[8,2,6,'2026-09-26 22:58:00+00',null,'on_time'],
    [9,3,10,'2026-09-19 12:00:00+00',41,'on_time'],[10,4,1,'2026-09-15 20:00:00+00',99,'on_time'],
    [11,4,4,'2026-09-16 07:45:00+00',72,'late'],[12,4,10,'2026-09-15 18:20:00+00',85,'on_time'],
    [13,4,3,'2026-09-14 16:00:00+00',93,'on_time'],[14,4,4,'2026-09-18 11:00:00+00',81,'resubmitted'],
    [15,5,1,'2026-09-29 20:10:00+00',null,'on_time'],[16,5,10,'2026-09-30 14:00:00+00',null,'late'],
    [17,6,7,'2026-09-17 09:00:00+00',19,'on_time'],[18,6,12,'2026-09-19 08:30:00+00',12,'late'],
    [19,6,3,'2026-09-18 15:00:00+00',17,'on_time'],[20,1,12,'2026-09-20 10:00:00+00',66,'resubmitted'],
    [21,3,2,'2026-09-21 13:00:00+00',38,'late'],[22,6,7,'2026-09-20 09:00:00+00',20,'resubmitted']
  ]
};

