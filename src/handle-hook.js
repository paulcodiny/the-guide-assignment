const { promisify } = require('util');

function errorNotifier(errorText) {
    return function (error) {
        logger.info(errorText);

        return Promise.reject(error);
    }
}

async function getPackageJson({ projectCloneUrl, branch }) {
    const gitlabApiInput = {
        group: Project.getGroupByCloneUrl(projectCloneUrl),
        project: Project.getProjectByCloneUrl(projectCloneUrl),
        branch,
        fileName: 'package.json',
    };

  return await promisify(gitlabApiClient.getFile)(gitlabApiInput)
      .catch(errorNotifier(`Package.json not found in ${branch} branch`));
}

async function getProjectInfo(packageJson) {
  return await promisify(projectService.findProjectByID)(packageJson.name)
      .catch(errorNotifier(`An error occured when retrieving ${packageJson.name}`));
}

function getReleaseConfiguration(packageJson, project, { mergeRequest, targetBranch, branch }) {
    let releaseConfiguration;
    if (mergeRequest === true) {
        releaseConfiguration = Project.getReleaseConfigurationForBranch(
            targetBranch,
            project.release_configuration
        );
        releaseConfiguration.release = false;
    } else {
        releaseConfiguration = Project.getReleaseConfigurationForBranch(
            branch,
            project.release_configuration
        ) || Project.getReleaseConfigurationForBranch(
            project.onboard_branch_prefix,
            project.release_configuration
        );
    }

    if (!releaseConfiguration) {
        logger.info(`Not triggering build for ${branch} branch of ${packageJson.name} no runner job specified`);

        throw new Error('Not triggering', 42);
    }

    return releaseConfiguration;
}

function isOnboard({ onboard_branch_prefix }, { branch }) {
    return onboard_branch_prefix && branch.startsWith(onboard_branch_prefix + '\\');
}

async function getVersionInfo(packageJson, project, { branch, sha }) {
    return await promisify(getVersionToBuild)(
        packageJson,
        project.id,
        branch,
        sha,
    ).catch(errorNotifier(`Could not find a version for ${packageJson.name}`));
}

async function createBuild(
    packageJson,
    project,
    releaseConfiguration,
    version,
    pushId,
    { branch }
) {
    const build = new Build({
        initiator_project_id: project.id,
        project_id: project.id,
        type: project.type,
        branch,
        version,
        push_id: pushId,
        visible_at_dashboard: releaseConfiguration.release,
        onboard: isOnboard(project, { branch }),
    });
    build.setStatus('queued');

    return await promisify(buildService.insertBuild)(build)
        .catch(errorNotifier(`Could not save the build for ${packageJson.name}`));
}

async function startContinuousIntegrationJob(
    packageJson,
    project,
    releaseConfiguration,
    version,
    build,
    { projectCloneUrl, branch }
) {
    const buildId = build.generated_keys[0];

    return promisify(gitlabApiClient.setCommitStatus)(buildId)
        .then((errorSetCommit) => {
            if (errorSetCommit) {
                logger.info('could not update the status of the git commit.');
            }

            return promisify(buildServerClient.triggerJenkinsJob)({
                project_type: project.type,
                project,
                project_clone_url: projectCloneUrl,
                project_branch: branch,
                project_version: version,
                build_id: buildId,
                onboard: isOnboard(project, { branch }),
                releaseConfiguration,
            });
        })
        .then((errorTriggerJenkinsJob, resultTriggerJenkinsJob) => {
            if (!errorTriggerJenkinsJob && resultTriggerJenkinsJob === true) {
                return done();
            }

            const subject = `Could not trigger jenkins job for v${packageJson.version}`;
            notificationService.insertNotificationForBuild(
                subject,
                errorTriggerJenkinsJob.toString(),
                'error',
                project.id,
                branch,
                buildId
            );

            return promisify(buildServiceService.updateBuildStatus)({
                build_id: buildId,
                status: 'error',
                extra_information: errorTriggerJenkinsJob.toString(),
                enddatetime: new Date(),
            });
        })
        .then((errorUpdateBuild, resultUpdateBuild) => {
            if (!errorUpdateBuild) {
                return errorCallback(`Could not trigger jenkins job for ${packageJson.name}`, done)(errorTriggerJenkinsJob, resultTriggerJenkinsJob);
            }

            notificationService.insertNotificationForBuild(
                subject,
                errorUpdateBuild.toString(),
                'error',
                project.id,
                branch,
                buildId
            );

            return errorCallback(`Could not update build record with id: ${buildId}`, done)(errorUpdateBuild, resultUpdateBuild);
        });
}

async function handleHookAsync(input, pushId) {
    const validateError = validateInput(input);
    if (validateError) {
        throw new Error(validateError, 21);
    }

    // Get the packageJson from gitlab
    const packageJson = await getPackageJson(input);

    // Get the project, based on the name in the packageJson
    const project = await getProjectInfo(packageJson);

    // Check if build is required
    const releaseConfiguration = getReleaseConfiguration(packageJson, project, input);

    // Check versions
    const version = await getVersionInfo(packageJson, project, input);

    // Create and save the new build
    const build = await createBuild(packageJson, project, releaseConfiguration, version, pushId, input);

    // Start the jenkins job
    return startContinuousIntegrationJob(packageJson, project, releaseConfiguration, version, build, input);
}

function handleHook(input, pushId, callback) {
    handleHookAsync(input, pushId)
        .then(callback)
        .catch(callback);
}