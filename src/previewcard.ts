import ogs from "open-graph-scraper";

export interface PreviewCard {
  url: string;
  title: string;
  description: string | null;
  image: {
    url: string;
    type: string | null;
    width: number | null;
    height: number | null;
  } | null;
}

export async function fetchPreviewCard(
  url: string | URL,
): Promise<PreviewCard | null> {
  let response: Awaited<ReturnType<typeof ogs>>;
  try {
    response = await ogs({ url: url.toString() });
  } catch (_) {
    return null;
  }
  const { error, result } = response;
  if (error || !result.success || result.ogTitle == null) return null;
  return {
    url: result.ogUrl ?? url.toString(),
    title: result.ogTitle,
    description: result.ogDescription ?? "",
    image:
      result.ogImage == null || result.ogImage.length < 1
        ? null
        : {
            url: result.ogImage[0].url,
            type: result.ogImage[0].type ?? null,
            width:
              result.ogImage[0].width == null
                ? null
                : Number.parseInt(
                    result.ogImage[0].width as unknown as string,
                    10,
                  ),
            height:
              result.ogImage[0].height == null
                ? null
                : Number.parseInt(
                    result.ogImage[0].height as unknown as string,
                    10,
                  ),
          },
  };
}
