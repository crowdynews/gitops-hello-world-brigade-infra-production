'use strict';

const { events, Job, Group } = require('brigadier');

const _hubCredentials = secrets => `
cat << EOF > $HOME/.config/hub
github.com:
  - protocol: https
    user: ${secrets.GITHUB_USERNAME}
    oauth_token: ${secrets.GITHUB_TOKEN}
EOF
`;

const _hubConfig = (email, name) => `
hub config --global credential.https://github.com.helper /usr/local/bin/hub-credential-helper
hub config --global hub.protocol https
hub config --global user.email "${email}"
hub config --global user.name "${name}"
`;

const _commitImage = (image, buildID) => `
cat << EOF > patch.yaml
spec:
  template:
    spec:
      containers:
        - name: gitops-hello-world-brigade
          image: ${image}
EOF

kubectl patch --local -o yaml \
  -f kubernetes/deployment.yaml \
  -p "$(cat patch.yaml)" \
  > deployment.yaml

mv deployment.yaml kubernetes/deployment.yaml

git checkout -b update-deployment-${buildID}

hub add kubernetes/deployment.yaml

hub commit -F- << EOF
Update hello world REST API

This commit updates the deployment container image to:
  ${image}

Build ID:
  ${buildID}
EOF
`;

const _pushCommit = (cloneURL, buildID) => `
hub remote add origin ${cloneURL}

hub push origin update-deployment-${buildID}
`;

const _pullRequest = (image, buildID) => `
hub pull-request -F- <<EOF
Update hello world REST API

This commit updates the deployment container image to:
  ${image}

Build ID:
  ${buildID}
EOF
`;

events.on('gcr_image_push', (brigadeEvent, project) => {
  const buildID = brigadeEvent.buildID;

  console.log('[EVENT] "gcr_image_push" - build ID: ', buildID);

  const payload = JSON.parse(brigadeEvent.payload);
  const imageAction = payload.imageData.action; // "INSERT" or "DELETE"
  const image = payload.imageData.tag;

  console.log('image action: ', imageAction);
  console.log('image: ', image);

  const infraJob = new Job('update-infra-config-pr');

  infraJob.storage.enabled = false;
  infraJob.image = 'gcr.io/hightowerlabs/hub';
  infraJob.tasks = [
    _hubCredentials(project.secrets),
    _hubConfig('gitops-bot@crowdynews.com', 'GitOps Bot'),
    'cd src',
    _commitImage(image, buildID),
    _pushCommit(project.repo.cloneURL, buildID),
    _pullRequest(imagae, buildID)
  ];

  const projectName = project.name;
  const projectURL = `https://${projectName}`;
  const imageURL = `https://${image}`;
  const kashtiURL = `${project.secrets.KASHTI_URL}/#!/build/${buildID}`;
  const slackJob = new Job('slack-notify-update-infra');

  slackJob.storage.enabled = false;
  slackJob.image = 'technosophos/slack-notify';
  slackJob.tasks = ['/slack-notify'];
  slackJob.env = {
    SLACK_WEBHOOK: project.secrets.SLACK_WEBHOOK,
    SLACK_TITLE: 'Infra Config Update',
    SLACK_MESSAGE: `Project <${projectURL}|${projectName}>\nDocker image <${imageURL}|${image}>\nBuild <${kashtiURL}|${buildID}>`,
    SLACK_COLOR: '#89ddff'
  };

  slackJob.run();

  const pipeline = new Group();

  pipeline.add(infraJob);
  pipeline.add(slackJob);
  pipeline.runEach();
});

events.on('pull_request', (brigadeEvent, project) => {
  const buildID = brigadeEvent.buildID;

  console.log('[EVENT] "pull_request" - build ID: ', buildID);

  const projectName = project.name;
  const projectURL = `https://${projectName}`;
  const commitSHA = brigadeEvent.revision.commit;
  const shortCommitSHA = commitSHA.substr(0, 7);
  const commitURL = `https://${projectName}/commit/${commitSHA}`;
  const kashtiURL = `${project.secrets.KASHTI_URL}/#!/build/${buildID}`;
  const slackJob = new Job('slack-notify-pr-prod');

  slackJob.storage.enabled = false;
  slackJob.image = 'technosophos/slack-notify';
  slackJob.tasks = ['/slack-notify'];
  slackJob.env = {
    SLACK_WEBHOOK: project.secrets.SLACK_WEBHOOK,
    SLACK_TITLE: 'PR Waiting for Approval',
    SLACK_MESSAGE: `Project <${projectURL}|${projectName}>\nCommit <${commitURL}|${shortCommitSHA}>\nBuild <${kashtiURL}|${buildID}>`,
    SLACK_COLOR: '#ffcb6b'
  };

  const pipeline = new Group();

  pipeline.add(slackJob);
  pipeline.runEach();
});

events.on('push', (brigadeEvent, project) => {
  const buildID = brigadeEvent.buildID;

  console.log('[EVENT] "push" - build ID: ', buildID);

  const deployJob = new Job('deploy-to-prod');

  deployJob.storage.enabled = false;
  deployJob.image = 'gcr.io/cloud-builders/kubectl';
  deployJob.tasks = ['cd src', 'kubectl apply --recursive -f kubernetes'];

  const projectName = project.name;
  const projectURL = `https://${projectName}`;
  const commitSHA = brigadeEvent.revision.commit;
  const shortCommitSHA = commitSHA.substr(0, 7);
  const commitURL = `https://${projectName}/commit/${commitSHA}`;
  const kashtiURL = `${project.secrets.KASHTI_URL}/#!/build/${buildID}`;
  const slackJob = new Job('slack-notify-deploy-prod');

  slackJob.storage.enabled = false;
  slackJob.image = 'technosophos/slack-notify';
  slackJob.tasks = ['/slack-notify'];
  slackJob.env = {
    SLACK_WEBHOOK: project.secrets.SLACK_WEBHOOK,
    SLACK_TITLE: 'Deploy to Production',
    SLACK_MESSAGE: `Project <${projectURL}|${projectName}>\nCommit <${commitURL}|${shortCommitSHA}>\nBuild <${kashtiURL}|${buildID}>`,
    SLACK_COLOR: '#c3e88d'
  };

  const pipeline = new Group();

  // pipeline.add(deployJob);
  pipeline.add(slackJob);
  pipeline.runEach();
});

events.on('error', (brigadeEvent, project) => {
  console.log('[EVENT] "error" - brigade event: ', brigadeEvent);
});
