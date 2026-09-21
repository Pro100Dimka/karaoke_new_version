#include "diagnostics/GraphIntrospection.hpp"
void GraphIntrospection::set(GraphSnapshot snapshot) {
    snapshot_ = std::move(snapshot);
}
GraphSnapshot GraphIntrospection::snapshot() const {
    return snapshot_;
}
