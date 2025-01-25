/**
 * GetRegion from S3 Endpoint URL
 * @param endPoint
 */
const getFormattedEndpoint = (envEndpoint?: string, envRegion?: string) => {
  if (!(!envRegion || envRegion === "")) return envRegion;

  if (
    !envEndpoint ||
    !envEndpoint.startsWith("https://") ||
    envEndpoint.includes("s3-website-")
  ) {
    throw Error(`Endpoint: '${envEndpoint}' is not S3 Object URL.`);
  }

  //https://hollo-backets.s3.ap-northeast-1.amazonaws.com/
  const envEndpointArr = envEndpoint.split(".");
  console.log(envEndpointArr);

  const formattedRegion = envEndpointArr.slice(-3, -2)[0];
  return formattedRegion;
};

console.log(
  getFormattedEndpoint(
    "https://s.3hollo-backets.s3.ap-northeast-1.amazonaws.com/",
  ),
);

//arn:aws:s3:::s3-hal-test-cors-bucket
//http://s3.s3.s3-testbucket.s3-website-ap-northeast-1.amazonaws.com
