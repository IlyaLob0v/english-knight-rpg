// LTI 1.3 / LTI Advantage claim names. Spec: https://www.imsglobal.org/spec/lti/v1p3
const LTI = "https://purl.imsglobal.org/spec/lti/claim";

export const CLAIM = {
  messageType: `${LTI}/message_type`,
  version: `${LTI}/version`,
  deploymentId: `${LTI}/deployment_id`,
  targetLinkUri: `${LTI}/target_link_uri`,
  resourceLink: `${LTI}/resource_link`,
  roles: `${LTI}/roles`,
  context: `${LTI}/context`,
  custom: `${LTI}/custom`,
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
} as const;

export const AGS_SCOPE = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  lineItemReadOnly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
} as const;

export interface AgsEndpoint {
  scope: string[];
  lineitems?: string;
  lineitem?: string;
}

export interface LaunchContext {
  iss: string;
  clientId: string;
  deploymentId: string;
  /** The LMS user id: stable and pseudonymous per platform. */
  sub: string;
  roles: string[];
  contextId?: string;
  resourceLinkId: string;
  ags?: AgsEndpoint;
  custom: Record<string, string>;
}
