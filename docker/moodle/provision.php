<?php
// Sets up the local Moodle as an LTI 1.3 platform for the game, idempotently:
//  - registers the gateway as an LTI 1.3 tool with grade sync (AGS) and column management;
//  - creates a test course with a student and a teacher;
//  - adds one LTI activity per module (custom parameter module_id), each with a gradebook column.
// Prints the gateway's LTI_PLATFORMS JSON on stdout; progress goes to stderr.
//
// Run inside the moodle container (docker/setup.sh does this):
//   MOONBRIDGE_MODULES='[{"id":"A1_VerbToBe_01","title":"..."}]' php /provision/provision.php

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');

function say(string $message): void {
    fwrite(STDERR, "[provision] $message\n");
}

$toolurl = rtrim(getenv('MOONBRIDGE_TOOL_URL') ?: 'http://localhost:8787', '/');
// Fetched by Moodle itself (server side), so it names the Docker host, not localhost.
$jwksurl = getenv('MOONBRIDGE_TOOL_JWKS_URL') ?: 'http://host.docker.internal:8787/.well-known/jwks.json';
$clientid = getenv('MOONBRIDGE_CLIENT_ID') ?: 'moonbridge-dev';
$modules = json_decode(getenv('MOONBRIDGE_MODULES') ?: '[]', true);
$studentpass = getenv('MOONBRIDGE_STUDENT_PASSWORD') ?: 'Moonbridge-Student-1';
$teacherpass = getenv('MOONBRIDGE_TEACHER_PASSWORD') ?: 'Moonbridge-Teacher-1';

\core\session\manager::set_user(get_admin());

// Moodle refuses server-side HTTP to private addresses by default; the gateway runs on the Docker host.
set_config('curlsecurityblockedhosts', '');
set_config('curlsecurityallowedport', '');
// A test site sends no mail (enrolment notices would otherwise fail on the dummy SMTP host).
set_config('noemailever', 1);

// ---------- The tool
$type = $DB->get_record('lti_types', ['clientid' => $clientid]);
$config = new stdClass();
$config->lti_toolurl = "$toolurl/lti/launch";
$config->lti_initiatelogin = "$toolurl/lti/login";
$config->lti_redirectionuris = "$toolurl/lti/launch";
$config->lti_keytype = LTI_JWK_KEYSET;
$config->lti_publickeyset = $jwksurl;
$config->lti_ltiversion = LTI_VERSION_1P3;
$config->lti_clientid = $clientid;
$config->lti_typename = 'Moonbridge';
$config->lti_description = 'Moonbridge school platform (local gateway)';
$config->lti_coursevisible = LTI_COURSEVISIBLE_ACTIVITYCHOOSER;
$config->lti_launchcontainer = LTI_LAUNCH_CONTAINER_EMBED_NO_BLOCKS;
// The game needs no names or emails: xAPI uses a pseudonymous account.
$config->lti_sendname = LTI_SETTING_NEVER;
$config->lti_sendemailaddr = LTI_SETTING_NEVER;
$config->lti_acceptgrades = LTI_SETTING_ALWAYS;
$config->lti_forcessl = 0;
$config->lti_contentitem = 0;
// 2 = "Use this service for grade sync and column management" (AGS score + lineitem scopes).
$config->ltiservice_gradesynchronization = 2;
$config->ltiservice_memberships = 0;
$config->ltiservice_toolsettings = 0;

if ($type) {
    $typeid = $type->id;
    $config->lti_typename = $type->name;
    lti_update_type($type, $config);
    say("tool type $typeid updated");
} else {
    $type = new stdClass();
    $type->state = LTI_TOOL_STATE_CONFIGURED;
    $type->course = SITEID;
    $typeid = lti_add_type($type, $config);
    say("tool type $typeid created");
}

// ---------- Course and people
$course = $DB->get_record('course', ['shortname' => 'KNIGHT']);
if (!$course) {
    $course = create_course((object) [
        'fullname' => 'Moonbridge (test course)',
        'shortname' => 'KNIGHT',
        'category' => core_course_category::get_default()->id,
        'format' => 'topics',
        'numsections' => 1,
    ]);
    say("course {$course->id} created");
}

function ensure_user(string $username, string $first, string $last, string $password): stdClass {
    global $DB, $CFG;
    $user = $DB->get_record('user', ['username' => $username, 'mnethostid' => $CFG->mnet_localhost_id]);
    if ($user) {
        return $user;
    }
    $id = user_create_user((object) [
        'username' => $username,
        'password' => $password,
        'firstname' => $first,
        'lastname' => $last,
        'email' => "$username@example.com",
        'auth' => 'manual',
        'confirmed' => 1,
        'mnethostid' => $CFG->mnet_localhost_id,
    ], true, false);
    say("user $username created");
    return $DB->get_record('user', ['id' => $id]);
}

$roles = [
    'student' => $DB->get_field('role', 'id', ['shortname' => 'student']),
    'editingteacher' => $DB->get_field('role', 'id', ['shortname' => 'editingteacher']),
];
enrol_try_internal_enrol($course->id, ensure_user('student', 'Sam', 'Student', $studentpass)->id, $roles['student']);
enrol_try_internal_enrol($course->id, ensure_user('teacher', 'Tess', 'Teacher', $teacherpass)->id, $roles['editingteacher']);
// A throwaway student per end-to-end run (e2e/lms.e2e.ts), so every run starts from an empty gradebook.
if ($e2e = getenv('MOONBRIDGE_E2E_STUDENT')) {
    enrol_try_internal_enrol($course->id, ensure_user($e2e, 'E2E', $e2e, getenv('MOONBRIDGE_E2E_PASSWORD') ?: $studentpass)->id, $roles['student']);
}

// ---------- One activity per module
foreach ($modules as $m) {
    $name = "Moonbridge: {$m['title']}";
    if ($DB->record_exists('lti', ['course' => $course->id, 'name' => $name])) {
        continue;
    }
    create_module((object) [
        'modulename' => 'lti',
        'course' => $course->id,
        'section' => 1,
        'visible' => 1,
        'name' => $name,
        'introeditor' => ['text' => '', 'format' => FORMAT_HTML, 'itemid' => 0],
        'typeid' => $typeid,
        'toolurl' => '',
        'securetoolurl' => '',
        'instructorcustomparameters' => "module_id={$m['id']}",
        'launchcontainer' => LTI_LAUNCH_CONTAINER_DEFAULT,
        'instructorchoiceacceptgrades' => LTI_SETTING_ALWAYS,
        'instructorchoicesendname' => LTI_SETTING_NEVER,
        'instructorchoicesendemailaddr' => LTI_SETTING_NEVER,
        'grade' => 100,
        'showtitlelaunch' => 1,
        'showdescriptionlaunch' => 0,
        'icon' => '',
        'secureicon' => '',
        'cmidnumber' => '',
    ]);
    say("activity \"$name\" created");
}

// The activity's gradebook column answers to resource_id = module id, so a result for this
// module lands in it even when the game was opened from another module's activity.
foreach ($modules as $m) {
    $ltiid = $DB->get_field('lti', 'id', ['course' => $course->id, 'name' => "Moonbridge: {$m['title']}"]);
    if ($ltiid) {
        $DB->set_field('ltiservice_gradebookservices', 'resourceid', $m['id'], ['ltilinkid' => $ltiid, 'courseid' => $course->id]);
    }
}

// ---------- What the gateway needs (PlatformConfig[])
echo json_encode([[
    'issuer' => $CFG->wwwroot,
    'clientId' => $clientid,
    'deploymentIds' => [(string) $typeid],
    'authLoginUrl' => "{$CFG->wwwroot}/mod/lti/auth.php",
    'authTokenUrl' => "{$CFG->wwwroot}/mod/lti/token.php",
    'jwksUrl' => "{$CFG->wwwroot}/mod/lti/certs.php",
]], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
