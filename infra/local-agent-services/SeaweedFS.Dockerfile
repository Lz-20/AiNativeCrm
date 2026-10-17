# The unmodified upstream 3.95 linux_arm64 release binary, verified before build.
FROM scratch
COPY weed /weed
WORKDIR /data
ENTRYPOINT ["/weed", "-logtostderr=true"]
