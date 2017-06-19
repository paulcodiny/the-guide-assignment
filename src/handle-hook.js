function handleHook(input, pushId, callback) {
    const validateError = validateInput(input);
    if (validateError) {
        return callback(validateError);
    }
    // Lets shorten variables we need multiple times
    const projectCloneUrl = input.projectCloneUrl;
    const branch = input.branch;
    async.waterfall([
        // Get the packageJson from gitlab
        (done) => {
            const gitlabApiInput = {
                group: Project.getGroupByCloneUrl(projectCloneUrl),
                project: Project.getProjectByCloneUrl(projectCloneUrl),
                branch,
                fileName: 'package.json',
            };
            gitlabApiClient.getFile(
                gitlabApiInput,
                errorCallback(`Package.json not found in ${branch} branch`, done)
            );
        },
        // // Get the project, based on the name in the packageJson
        (packageJson, done) => {
            projectService.findProjectByID(packageJson.name,
                errorCallback(
                    `An error occured when retrieving ${packageJson.name}`,
                    packageJson,
                    done
                )
            );
        },
        // Check if build is required
        (packageJson, project, done) => {
            let onboard = false;
            if (project.onboard_branch_prefix) {
                const regex = new RegExp(`^${project.onboard_branch_prefix}\\w+`);
                onboard = regex.test(branch);
            }
            let release_configuration;
            if (input.mergeRequest === true) {
                release_configuration = Project.getReleaseConfigurationForBranch(input.targetBranch, project.release_configuration);
                release_configuration.release = false;
            } else {
                release_configuration = Project.getReleaseConfigurationForBranch(branch, project.release_configuration) || Project.getReleaseConfigurationForBranch(project.onboard_branch_prefix, project.release_configuration);
            }
            if (!release_configuration) {
                logger.info(`Not triggering build for ${branch} branch of ${packageJson.name} no runner job specified`);
                return done('not triggering');
            }
            return done(null, packageJson, project, release_configuration, onboard);
        },
        // check versions
        (packageJson, project, release_configuration, onboard, done) => {
            getVersionToBuild(
                packageJson,
                project.id,
                branch,
                input.sha,
                errorCallback(
                    `Could not find a version for ${packageJson.name}`,
                    packageJson,
                    project,
                    release_configuration,
                    onboard,
                    done
                )
            );
        },
        // Create and save the new build
        (packageJson, project, release_configuration, onboard, version, done) => {
            const build = new Build({
                initiator_project_id: project.id,
                project_id: project.id,
                type: project.type,
                branch,
                version,
                push_id: pushId,
                visible_at_dashboard: release_configuration.release,
                onboard,
            });
            build.setStatus('queued');
            buildService.insertBuild(build, errorCallback(
                `Could not save the build for ${packageJson.name}`,
                packageJson,
                project,
                release_configuration,
                onboard,
                version,
                done
            ));
        },
        // Start the jenkins job
        (packageJson, project, release_configuration, onboard, version, savedBuild, done) => {
            const buildId = savedBuild.generated_keys[0];
            gitlabApiClient.setCommitStatus(buildId, (errorSetCommit) => {
                if (errorSetCommit) {
                    logger.info('could not update the status of the git commit.');
                }
                buildServerClient.triggerJenkinsJob({
                    project_type: project.type,
                    project,
                    project_clone_url: projectCloneUrl,
                    project_branch: branch,
                    project_version: version,
                    build_id: buildId,
                    onboard,
                    release_configuration,
                }, (errorTriggerJenkinsJob, resultTriggerJenkinsJob) => {
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
                    buildServiceService.updateBuildStatus({
                        build_id: buildId,
                        status: 'error',
                        extra_information: errorTriggerJenkinsJob.toString(),
                        enddatetime: new Date(),
                    }, (errorUpdateBuild, resultUpdateBuild) => {
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
                });
            });
        }
    ], callback);
}
